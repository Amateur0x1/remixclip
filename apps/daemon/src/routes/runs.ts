/**
 * [INPUT]: conversation run requests, the project a turn runs in and the global agent choice.
 * [OUTPUT]: pure-chat run (spawns a local agent), SSE event stream, status query and cancel.
 * [POS]: daemon's conversation run routes.
 * Runs routes — open-design protocol:
 *   POST /api/runs                 create a run (spawns a local agent; the same session
 *                                  automatically resumes the upstream agent session,
 *                                  body.resume=false forces a new session)
 *   GET  /api/runs                 list runs
 *   GET  /api/runs/:id             query run status (incl. the sessionId session handle)
 *   GET  /api/runs/:id/events      SSE event stream (supports ?after=<seq> reconnect;
 *                                  the end frame carries sessionId)
 *   POST /api/runs/:id/cancel      cancel a run
 *
 * Agent选择是全局的（app-config.agentId）；每个 turn 只携带 project，项目提供工作目录与项目指令。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { ChatAttachment, ChatRunCreateRequest, ChatRunCreateResponse } from '@remixclip/contracts';
import {
  PROMPT_LOCALE_EXEMPT_TERMS_SENTENCE,
  normalizePromptLocale,
  promptLanguageName,
} from '@remixclip/contracts';
import { defaultConversationTitle } from '../conversation-title.js';
import { getAgentDef } from '../runtimes/registry.js';
import type { RunManager, StoredEvent } from '../runtimes/runs.js';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { resolveAttachmentFile } from './workspaces.js';
import {
  appendMessage,
  clearConversationSession,
  createConversation,
  ensureDefaultProject,
  getConversationProjectId,
  getConversationSession,
  getProject,
  setConversationSession,
  touchConversation,
} from '../db.js';

/** Each project has one shared working dir: every conversation in it sees the same files. */
export function projectWorkspaceDir(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'projects', projectId);
}

export function registerRunsRoutes(
  app: Express,
  manager: RunManager,
  db: Database.Database,
  dataDir: string,
): void {
  // Hold the conversation's send slot while creating a run, preventing concurrent creates.
  const startingConversations = new Set<string>();
  const hasActiveRun = (conversationId: string) => manager.listRuns().some((run) =>
    run.conversationId === conversationId && (run.status === 'running' || run.status === 'queued' ||
      (run.status === 'cancelled' && manager.getRun(run.id)?.terminalAt === undefined)));

  // ── Create run ───────────────────────────────────────────────────────────
  app.post('/api/runs', async (req: Request, res: Response) => {
    const body = req.body as Partial<ChatRunCreateRequest>;
    const hasAttachments = Array.isArray(body?.attachments) && body.attachments.length > 0;
    if (!body || typeof body.message !== 'string' || (!body.message.trim() && !hasAttachments)) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 12)) {
      res.status(400).json({ error: '单次最多附带 12 个文件或图片' });
      return;
    }
    if ((body.conversationId != null && typeof body.conversationId !== 'string') ||
        (body.currentPrompt !== undefined && typeof body.currentPrompt !== 'string') ||
        (body.projectId != null && typeof body.projectId !== 'string')) {
      res.status(400).json({ error: '会话 ID、项目 ID 和当前提示词须为字符串' });
      return;
    }

    // The agent is a global preference; a turn may still override it explicitly.
    const appConfig = readAppConfig();
    const agentId = body.agentId || appConfig.agentId || 'claude';
    const def = getAgentDef(agentId);
    if (!def) {
      res.status(400).json({ error: `未知 agent：${agentId}` });
      return;
    }

    let lockedConversationId: string | null = null;
    let createdRunId: string | null = null;
    try {
      const conversationId = body.conversationId ?? null;
      if (conversationId) {
        if (startingConversations.has(conversationId) || hasActiveRun(conversationId)) {
          res.status(409).json({ error: '该对话已有进行中的 Agent 任务，请等待当前任务结束' }); return;
        }
        if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)) {
          res.status(404).json({ error: '会话不存在' }); return;
        }
        // The conversation's project is authoritative: a turn can never be retargeted at
        // another project (and thus another working dir / instruction set).
        const conversationProjectId = getConversationProjectId(db, conversationId);
        if (body.projectId && conversationProjectId && body.projectId !== conversationProjectId) {
          res.status(409).json({ error: '会话不属于该项目' }); return;
        }
        startingConversations.add(conversationId);
        lockedConversationId = conversationId;
      }
      const latestPrompt = (body.currentPrompt ?? body.message).trim();

      /**
       * UI language → one 'answer in this language' line in the prompt.
       *
       * `normalizePromptLocale` returns null for an English UI: the prompt itself is English,
       * so adding an English rule only makes every turn's prompt longer and entirely destroys
       * the upstream prefix cache, with zero information gain.
       */
      const promptLocale = normalizePromptLocale(body.locale);
      const localePrompt = promptLocale
        ? `## UI locale override\n\nRespond in ${promptLanguageName(promptLocale)}. ${PROMPT_LOCALE_EXEMPT_TERMS_SENTENCE}`
        : '';

      const resolvedAttachments: { attachment: ChatAttachment; absPath: string }[] =
        (body.attachments ?? []).map((item) => resolveAttachmentFile(dataDir, item));
      const verifiedAttachments = resolvedAttachments.map((item) => item.attachment);
      const attachmentsPrompt = resolvedAttachments.length > 0
        ? `## 用户随本轮消息附带的图片与文件（已保存在本机）\n` +
          `用户在本轮消息中上传/粘贴了以下图片或文件。请务必先使用文件读取工具（如 \`Read\`）直接读取查看这些路径（支持直接读取 PNG/JPG/WebP/GIF 截图图片、PDF 与各类文本/代码文件），严格结合图片中的界面视觉细节、文字报错或文件内容来执行任务：\n` +
          resolvedAttachments
            .map(({ attachment, absPath }) => `- [${attachment.mimeType.startsWith('image/') ? '图片' : '文件'}] ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) — 本地绝对路径：\`${absPath}\``)
            .join('\n')
        : '';

      // Write the DB only inside the synchronous commit window; on failure roll back conversation and user message.
      const defaultTitle =
        latestPrompt.slice(0, 40) || verifiedAttachments[0]?.name.slice(0, 40) || defaultConversationTitle(body.locale);
      const run = db.transaction(() => {
        // A conversation always belongs to a project; a new turn either resumes the
        // conversation's project or lands in the requested one (default project as fallback).
        const projectId = conversationId
          ? (getConversationProjectId(db, conversationId) ?? ensureDefaultProject(db).id)
          : (body.projectId && getProject(db, body.projectId) ? body.projectId : ensureDefaultProject(db).id);
        const project = getProject(db, projectId);
        const targetId = conversationId ?? createConversation(db, projectId, defaultTitle).id;
        touchConversation(db, targetId);
        const cwd = projectWorkspaceDir(dataDir, projectId);
        mkdirSync(cwd, { recursive: true });

        const promptSections = [
          `## 当前工作目录\n${cwd}\n工具产出的文件请写在当前工作目录内，回复中给出完整相对路径。`,
          // Placed before the project instructions: earlier sections are more stable and more
          // reusable by the upstream prefix cache. English UI normalizes to null, the whole
          // section disappears — the bytes saved are exactly the cache hit rate.
          localePrompt,
          project?.customInstructions?.trim()
            ? `## 项目指令\n\n${project.customInstructions.trim()}`
            : '',
          attachmentsPrompt,
          (body.message ?? '').trim() || (verifiedAttachments.length > 0 ? '请先查看我随消息附带的图片/文件，并根据其中的内容进行处理。' : ''),
        ].filter(Boolean);
        const prompt = promptSections.join('\n\n---\n\n');

        // The upstream session must match both the agent and the actual working directory.
        const storedSession = body.resume === false ? null : getConversationSession(db, targetId);
        const resumeSessionId = storedSession?.agentId === def.id && storedSession.cwd === cwd ? storedSession.sessionId : null;
        if (!resumeSessionId) clearConversationSession(db, targetId);

        const created = manager.createRun({
          def,
          prompt,
          conversationId: targetId,
          model: body.model ?? appConfig.agentModels?.[def.id] ?? null,
          cwd,
          configuredEnv: agentCliEnvForAgent(appConfig, def.id),
          resumeSessionId,
        });
        createdRunId = created.id;
        appendMessage(db, {
          conversationId: targetId,
          role: 'user',
          content: latestPrompt,
          runId: created.id,
          attachments: verifiedAttachments.length > 0 ? verifiedAttachments : undefined,
        });
        return created;
      })();

      persistRunOnTerminal(manager, run.id, run.conversationId, db, def.id);

      const response: ChatRunCreateResponse = { runId: run.id, conversationId: run.conversationId };
      res.json(response);
    } catch (error) {
      if (createdRunId) manager.cancelRun(createdRunId, '创建运行失败');
      const message = error instanceof Error ? error.message : '创建 run 失败';
      res.status(/会话不存在|附件/.test(message) ? 400 : 500).json({ error: message });
    } finally {
      if (lockedConversationId) startingConversations.delete(lockedConversationId);
    }
  });

  // ── List / status ────────────────────────────────────────────────────────
  app.get('/api/runs', (_req: Request, res: Response) => {
    res.json({ runs: manager.listRuns() });
  });

  app.get('/api/runs/:id', (req: Request, res: Response) => {
    const run = manager.getRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'run 不存在' });
      return;
    }
    res.json(manager.toStatus(run));
  });

  // ── SSE event stream ─────────────────────────────────────────────────────
  app.get('/api/runs/:id/events', (req: Request, res: Response) => {
    const run = manager.getRun(String(req.params.id));
    if (!run) {
      res.status(404).json({ error: 'run 不存在' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const afterSeq = req.query.after != null ? Number(req.query.after) : undefined;
    let closed = false;

    const send = (ev: StoredEvent) => {
      if (closed) return;
      res.write(`id: ${ev.seq}\n`);
      res.write(`event: ${ev.event}\n`);
      res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
    };

    const { unsubscribe, terminal } = manager.subscribe(run.id, send, afterSeq);

    // Terminal run: backlog replayed, close the stream.
    if (terminal) {
      res.end();
      return;
    }

    const keepAlive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 15_000);

    // Close shortly after the run reaches a terminal state.
    const closeWatcher = setInterval(() => {
      const current = manager.getRun(run.id);
      if (!current || current.status !== 'running') {
        setTimeout(() => {
          if (!closed) {
            closed = true;
            unsubscribe();
            clearInterval(keepAlive);
            clearInterval(closeWatcher);
            res.end();
          }
        }, 250);
      }
    }, 250);

    req.on('close', () => {
      closed = true;
      unsubscribe();
      clearInterval(keepAlive);
      clearInterval(closeWatcher);
    });
  });

  // ── Cancel ───────────────────────────────────────────────────────────────
  app.post('/api/runs/:id/cancel', (req: Request, res: Response) => {
    const ok = manager.cancelRun(String(req.params.id));
    if (!ok) {
      res.status(409).json({ error: 'run 不在运行中或不存在' });
      return;
    }
    res.json({ ok: true });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

const persistedRuns = new Set<string>();

function persistRunOnTerminal(
  manager: RunManager,
  runId: string,
  conversationId: string,
  db: Database.Database,
  agentId: string,
): void {
  if (persistedRuns.has(runId)) return;
  const persist = () => {
    const run = manager.getRun(runId);
    if (!run?.terminalAt || persistedRuns.has(runId)) return;
    persistedRuns.add(runId);
    // Persist synchronously inside the terminal event so the next turn never reads a stale
    // handle; the handle is bound to the actual cwd too.
    if (run.status === 'completed' && run.durableSessionId) {
      try {
        setConversationSession(db, conversationId, agentId, run.durableSessionId, run.cwd ?? null);
      } catch {
        // Persistence failure does not affect the main flow (next turn falls back to a new session)
      }
    }
    if (run.assistantText.trim() || run.artifacts?.length) {
      try {
        appendMessage(db, { conversationId, role: 'assistant', content: run.assistantText, runId: run.id, artifacts: run.artifacts });
      } catch {
        // Persistence failure does not affect the main flow
      }
    }
  };
  const { unsubscribe, terminal } = manager.subscribe(runId, (event) => {
    if (event.event === 'end' || event.event === 'error') persist();
  });
  if (terminal) { persist(); unsubscribe(); }
}
