/**
 * [INPUT]: local database, running agent tasks and the project a chat belongs to.
 * [OUTPUT]: create/query/delete conversations scoped by project; block deletion while running.
 * [POS]: daemon's conversation HTTP routes; one conversation is one chat inside a project.
 *
 * Every route hangs off `/api/projects/:id/conversations`, mirroring open-design: a
 * conversation is only addressable through the project that owns it, so a caller can never
 * read or delete a conversation by id alone. Ownership is not editable — a conversation is
 * created inside a project and dies with it.
 */
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { RunManager } from '../runtimes/runs.js';
import { defaultConversationTitle } from '../conversation-title.js';
import {
  createConversation,
  deleteConversation,
  getConversationProjectId,
  getProject,
  listConversations,
  listMessages,
} from '../db.js';

/** The conversation only routes when it actually belongs to the project in the path. */
function conversationBelongsToProject(
  db: Database.Database,
  projectId: string,
  conversationId: string,
): boolean {
  return getConversationProjectId(db, conversationId) === projectId;
}

export function registerConversationRoutes(app: Express, db: Database.Database, manager: RunManager): void {
  app.get('/api/projects/:id/conversations', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    if (!getProject(db, projectId)) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    res.json({ conversations: listConversations(db, projectId) });
  });

  // New conversation: the project is fixed at creation time.
  app.post('/api/projects/:id/conversations', (req: Request, res: Response) => {
    const projectId = String(req.params.id);
    if (!getProject(db, projectId)) {
      res.status(404).json({ error: '项目不存在' });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (title.length > 100 || /[\r\n\t]/.test(title)) {
      res.status(400).json({ error: '对话名称须为不超过 100 字的单行文本' });
      return;
    }
    try {
      const conversation = createConversation(
        db,
        projectId,
        title || defaultConversationTitle(req.body?.locale),
      );
      res.status(201).json({ conversation });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '创建对话失败' });
    }
  });

  app.get('/api/projects/:id/conversations/:cid/messages', (req: Request, res: Response) => {
    const conversationId = String(req.params.cid);
    if (!conversationBelongsToProject(db, String(req.params.id), conversationId)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json({ messages: listMessages(db, conversationId) });
  });

  app.delete('/api/projects/:id/conversations/:cid', (req: Request, res: Response) => {
    const conversationId = String(req.params.cid);
    if (!conversationBelongsToProject(db, String(req.params.id), conversationId)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    if (manager.listRuns().some((run) => run.conversationId === conversationId && (run.status === 'running' || run.status === 'queued'))) {
      res.status(409).json({ error: '对话正在运行，请等待任务结束后再删除' });
      return;
    }
    try {
      deleteConversation(db, conversationId);
      res.json({ ok: true });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : '删除失败' });
    }
  });
}
