/**
 * [INPUT]: the local database, the run manager and project CRUD requests.
 * [OUTPUT]: list / create / read / update / delete projects (each owns its conversations).
 * [POS]: daemon's project HTTP routes; a project is the container a chat belongs to.
 *
 * Ownership rules mirror open-design:
 *   - creating a project also creates its seed conversation (a project is never empty);
 *   - deleting a project cancels whatever is still running inside it, then removes the row
 *     (conversations go with it via ON DELETE CASCADE) and the working directory.
 */
import { mkdirSync, rmSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { CreateProjectRequest, UpdateProjectRequest } from '@remixclip/contracts';
import type { RunManager } from '../runtimes/runs.js';
import { defaultConversationTitle } from '../conversation-title.js';
import {
  createProjectWithConversation,
  deleteProject,
  getProject,
  listConversationIds,
  listProjects,
  listConversations,
  updateProject,
} from '../db.js';
import { materializeProjectReferences, projectWorkspaceDir, sourceLibraryItemIds } from '../project-workspace.js';

const MAX_NAME_LENGTH = 100;
const MAX_INSTRUCTIONS_LENGTH = 20_000;

function readName(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\r\n\t]/.test(name)) return null;
  return name;
}

function readInstructions(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.slice(0, MAX_INSTRUCTIONS_LENGTH);
}

export function registerProjectRoutes(
  app: Express,
  db: Database.Database,
  dataDir: string,
  manager: RunManager,
): void {
  app.get('/api/projects', (_req: Request, res: Response) => {
    // No seed project: a recreation needs library material, so the client asks the user to pick
    // some instead of opening an empty project that could never run a recreation.
    res.json({ projects: listProjects(db) });
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CreateProjectRequest;
    const name = readName(body.name);
    if (name === null) {
      res.status(400).json({ error: '项目名称须为不超过 100 字的单行文本' });
      return;
    }
    const customInstructions = readInstructions(body.customInstructions);
    try {
      const { project, conversation } = createProjectWithConversation(db, {
        name,
        customInstructions: customInstructions ?? null,
        metadata: body.metadata,
        conversationTitle: defaultConversationTitle(body.locale),
      });
      // A recreation project is born with its source clip: the first brief points the agent at
      // `reference/<name>`, so the file is already in the panel before the message is sent.
      // Best-effort — the run route materializes again at every turn, so a failed copy here only
      // costs one retry, while failing the POST would lose the project.
      if (sourceLibraryItemIds(project).length) {
        try {
          const cwd = projectWorkspaceDir(dataDir, project.id);
          mkdirSync(cwd, { recursive: true });
          materializeProjectReferences(db, cwd, project);
        } catch {
          // retried on the first run
        }
      }
      res.status(201).json({ project, conversation });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '创建项目失败' });
    }
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const project = getProject(db, String(req.params.id));
    if (!project) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ project, conversations: listConversations(db, project.id) });
  });

  app.patch('/api/projects/:id', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as UpdateProjectRequest;
    const name = readName(body.name);
    if (name === null) {
      res.status(400).json({ error: '项目名称须为不超过 100 字的单行文本' });
      return;
    }
    const customInstructions = readInstructions(body.customInstructions);
    const project = updateProject(db, String(req.params.id), {
      name: name ?? undefined,
      customInstructions,
      metadata: body.metadata,
    });
    if (!project) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ project });
  });

  app.delete('/api/projects/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!getProject(db, id)) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    // Deleting the last project is legitimate: the empty state is the material picker.
    try {
      // Stop every live agent run inside the project before its rows and directory are
      // removed — otherwise the CLI subprocess is orphaned and keeps writing into a
      // directory that no longer exists (open-design does the same).
      const conversationIds = new Set(listConversationIds(db, id));
      for (const run of manager.listRuns()) {
        if (run.conversationId && conversationIds.has(run.conversationId) && run.status === 'running') {
          manager.cancelRun(run.id, '项目已删除');
        }
      }
      deleteProject(db, id);
      // The project's working directory goes with it; a failure here is a harmless leftover.
      rmSync(projectWorkspaceDir(dataDir, id), { recursive: true, force: true });
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : '删除项目失败' });
    }
  });
}
