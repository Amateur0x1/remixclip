/**
 * [INPUT]: conversation run requests, the project a turn runs in and the selected agent.
 * [OUTPUT]: pure-chat run (spawns a local agent), SSE event stream, status query and cancel.
 * [POS]: daemon's conversation run routes; the only place that decides a turn's context.
 *
 * Runs routes — open-design protocol:
 *   POST /api/runs                 create a run (spawns a local agent; resumes this agent's
 *                                  upstream session when its handle is still valid, otherwise
 *                                  replays the conversation history; body.resume=false forces
 *                                  a brand-new session)
 *   GET  /api/runs                 list runs
 *   GET  /api/runs/:id             query run status (incl. the sessionId session handle)
 *   GET  /api/runs/:id/events      SSE event stream (supports ?after=<seq> reconnect;
 *                                  the end frame carries sessionId)
 *   POST /api/runs/:id/cancel      cancel a run
 *
 * Agent选择仍然是全局偏好（app-config.agentId），但 session 是 per-(conversation, agent) 的：
 * 切换 agent 不写任何东西，只是下一次 turn 在 agent_sessions 里 miss 一次。
 *
 * A recreation project also gets its source clip materialized into `<cwd>/reference/` here, before
 * the run is created, so the prompt can name a real local file instead of an expiring post URL.
 */

import { mkdirSync } from 'node:fs';
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { ChatAttachment, ChatRunCreateRequest, ChatRunCreateResponse } from '@remixclip/contracts';
import {
  PROMPT_LOCALE_EXEMPT_TERMS_SENTENCE,
  normalizePromptLocale,
  promptLanguageName,
} from '@remixclip/contracts';
import { defaultConversationTitle } from '../conversation-title.js';
import { DEFAULT_AGENT_ID, getAgentDef } from '../runtimes/registry.js';
import type { RunManager, StoredEvent } from '../runtimes/runs.js';
import { agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import { buildSkillsPrompt, materializeProjectSkills } from '../skills.js';
import { materializeProjectReferences, projectWorkspaceDir, sourceLibraryItemIds } from '../project-workspace.js';
import { syncProjectCut } from '../project-cuts.js';
import { buildTranscriptSection, isResumeFailure, planTurnContext } from '../agent-session.js';
import { buildTurnGuidancePrompt } from '../turn-guidance.js';
import { turnProcessFromEvents } from '../turn-process.js';
import { resolveAttachmentFile } from './workspaces.js';
import {
  appendMessage,
  clearAgentSession,
  ensureProjectConversation,
  getAgentSession,
  getConversationProjectId,
  getProject,
  latestAssistantMessageId,
  listMessages,
  upsertAgentSession,
  touchConversation,
} from '../db.js';

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
    const requestedAgentId = body.agentId || appConfig.agentId || null;
    let def = requestedAgentId ? getAgentDef(requestedAgentId) : null;
    // A saved runtime can be removed between releases; only an explicit request should 400.
    if (!def && !body.agentId) def = getAgentDef(DEFAULT_AGENT_ID);
    if (!def) {
      res.status(400).json({ error: `未知 agent：${requestedAgentId ?? DEFAULT_AGENT_ID}` });
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

      // A turn always runs inside a project. There is no seed project anymore, and a recreation
      // without library material has nothing to read, so refuse rather than invent one.
      const targetProjectId = conversationId
        ? getConversationProjectId(db, conversationId)
        : body.projectId && getProject(db, body.projectId) ? body.projectId : null;
      if (!targetProjectId) {
        res.status(400).json({ error: '请先从素材库选择素材并创建项目' });
        return;
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

      // Injected into the prompt, never into the message: history keeps the words the user sent.
      const guidancePrompt = buildTurnGuidancePrompt(body.guidance);

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
        // A conversation always belongs to a project; the project is resolved above and cannot be
        // retargeted by this request.
        const projectId = targetProjectId;
        const project = getProject(db, projectId);
        const targetId = conversationId ?? ensureProjectConversation(db, projectId, defaultTitle).id;
        touchConversation(db, targetId);
        const cwd = projectWorkspaceDir(dataDir, projectId);
        mkdirSync(cwd, { recursive: true });
        // Recreation source clips are COPIED into the project before the run starts: the library
        // cache is transient, and an agent reading it breaks as soon as the item is re-downloaded.
        // Must precede createRun — the artifact diff snapshots the workspace at spawn, so anything
        // already here is context, not a product of this turn.
        const references = materializeProjectReferences(db, cwd, project);
        const hasSources = sourceLibraryItemIds(project).length > 0;
        const referencesPrompt = buildReferencesPrompt(hasSources, references);
        const outputLayoutPrompt = buildOutputLayoutPrompt(hasSources);
        // Static catalog of the bundled skill library: same bytes every turn, and the agent
        // only reads a SKILL.md when a step actually needs that knowledge. The library is
        // copied into the project once so the run's sandbox can always read it.
        const skillsPrompt = buildSkillsPrompt(materializeProjectSkills(cwd));
        const model = body.model ?? appConfig.agentModels?.[def.id] ?? null;

        // The one decision this route owns: resume this agent's handle, or replay the history.
        // `stored` is looked up by (conversation, agent) — after a switch it is simply a miss,
        // nothing was overwritten, and the previous agent's handle is still there for later.
        // `listMessages` runs before this turn's user message is appended, so history never
        // contains the current turn twice.
        const plan = planTurnContext({
          stored: getAgentSession(db, targetId, def.id),
          forceNew: body.resume === false,
          model,
          cwd,
          latestAssistantMessageId: latestAssistantMessageId(db, targetId),
          messages: listMessages(db, targetId),
          agentId: def.id,
        });
        const transcriptPrompt = buildTranscriptSection(plan.history);

        const promptSections = [
          `## 当前工作目录\n${cwd}\n工具产出的文件请写在当前工作目录内，回复中给出完整相对路径。`,
          referencesPrompt,
          outputLayoutPrompt,
          skillsPrompt,
          // Placed before the project instructions: earlier sections are more stable and more
          // reusable by the upstream prefix cache. English UI normalizes to null, the whole
          // section disappears — the bytes saved are exactly the cache hit rate.
          localePrompt,
          project?.customInstructions?.trim()
            ? `## 项目指令\n\n${project.customInstructions.trim()}`
            : '',
          // Replay only when the handle is not reused: exactly one of the two always happens.
          transcriptPrompt,
          attachmentsPrompt,
          // Last section before the message: the dialog's requirements win over the base brief.
          guidancePrompt,
          (body.message ?? '').trim() || (verifiedAttachments.length > 0 ? '请先查看我随消息附带的图片/文件，并根据其中的内容进行处理。' : ''),
        ].filter(Boolean);
        const prompt = promptSections.join('\n\n---\n\n');

        const created = manager.createRun({
          def,
          prompt,
          conversationId: targetId,
          model,
          cwd,
          configuredEnv: agentCliEnvForAgent(appConfig, def.id),
          resumeSessionId: plan.resumeSessionId,
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

      persistRunOnTerminal(manager, run.id, run.conversationId, db, def.id, dataDir);

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

/**
 * Where a recreation's deliverables belong.
 *
 * Without this the renderer's own scaffold convention wins and the film ends up at
 * `videos/<name>/renders/...`, two levels below where the user browses. The rule sits next to the
 * reference section so the agent reads both in the same breath.
 *
 * Three buckets, one job each: `reference/` is the input, `output/` is what the user opens, and
 * `studio/` is everything used to get there — HTML, scripts, frames, logs. A folder called `videos/`
 * would claim to hold films while actually holding HTML and scripts.
 */
function buildOutputLayoutPrompt(hasSources: boolean): string {
  if (!hasSources) return '';
  return '## 产出位置与成片契约\n\n' +
    '工作目录按用途分三层，不要另起炉灶：\n\n' +
    '- `reference/`：原片，只读；\n' +
    '- `output/`：交付物，最终成片固定写到 `output/final.mp4`（渲染帧、截图可放 `output/frames/`）；\n' +
    '- `studio/`：制作工程（HTML、脚本、中间帧、试渲染、日志），例如 `studio/<名字>/index.html`。\n\n' +
    '成片契约（不要违反，成片库据此收录）：\n' +
    '- 最终成片只能有一支，路径必须是 `output/final.mp4`，重渲染直接覆盖它；\n' +
    '- `output/` 根目录下不要再放第二支视频（`.mp4` / `.mov` / `.webm`），试渲染放 `studio/`；\n' +
    '- 不要用 `videos/`、`src/` 装代码文件；成片完成后在回复里给出 `output/final.mp4`。';
}

/**
 * The one authoritative statement of "what the agent can read locally".
 *
 * Ground truth beats the brief: the user message says where the clip should be, this section says
 * what is actually on disk right now. An empty `reference/` (download still running) is stated
 * explicitly so the agent asks instead of inventing a fetch of the expired post URL.
 */
function buildReferencesPrompt(
  hasSources: boolean,
  references: { relPath: string; bytes: number }[],
): string {
  if (!hasSources) return '';
  if (references.length === 0) {
    return '## 参考素材\n\n这个项目要复刻的原片还没有复制到本地，工作目录下的 `reference/` 目前是空的。' +
      '不要访问原帖或视频直链（链接会过期、也常被防盗链拒绝），请先向用户确认素材是否已下载完成。';
  }
  const lines = references.map((file) => `- \`${file.relPath}\`（${(file.bytes / (1024 * 1024)).toFixed(1)} MB）`);
  return '## 参考素材（已在工作目录内）\n\n' +
    '项目要复刻的原片已经复制到工作目录，请直接用文件读取工具读取本地文件；不要访问原帖或视频直链（链接会过期、也常被防盗链拒绝）：\n\n' +
    lines.join('\n');
}

const persistedRuns = new Set<string>();

function persistRunOnTerminal(
  manager: RunManager,
  runId: string,
  conversationId: string,
  db: Database.Database,
  agentId: string,
  dataDir: string,
): void {
  if (persistedRuns.has(runId)) return;
  const persist = () => {
    const run = manager.getRun(runId);
    if (!run?.terminalAt || persistedRuns.has(runId)) return;
    persistedRuns.add(runId);

    // 1) Write the turn first: the cursor stored with the handle must be THIS run's assistant
    //    message id, otherwise the handle would look stale on the very next turn.
    let assistantId: string | null = null;
    if (run.assistantText.trim() || run.artifacts?.length) {
      try {
        const process = turnProcessFromEvents(run.events);
        // Duration cannot be rebuilt from the event stream, so it rides on the process payload:
        // the collapsed "Worked for …" header must show the same number after a reload.
        if (process) process.elapsedMs = run.terminalAt - run.createdAt;
        assistantId = appendMessage(db, {
          conversationId,
          role: 'assistant',
          agentId,
          content: run.assistantText,
          runId: run.id,
          artifacts: run.artifacts,
          // The chips the live view just showed must still be there after a reload: the run's
          // events are the only place they exist, and they die with the process otherwise.
          process,
        }).id;
      } catch {
        // Persistence failure does not affect the main flow
      }
    }

    // 2) The handle is a cache: write it on success, drop it when the resume itself failed.
    //    A dead handle that survives makes every later turn retry the same broken --resume,
    //    which looks exactly like "the model is broken".
    if (run.status === 'completed' && run.durableSessionId) {
      try {
        upsertAgentSession(db, {
          conversationId,
          agentId,
          sessionId: run.durableSessionId,
          model: run.model ?? null,
          cwd: run.cwd ?? null,
          lastMessageId: assistantId ?? latestAssistantMessageId(db, conversationId),
        });
      } catch {
        // Persistence failure does not affect the main flow (next turn replays instead)
      }
    } else if (run.resumeSessionId) {
      const text = [run.error ?? '', run.assistantText].join('\n');
      if (isResumeFailure(agentId, text)) {
        try {
          clearAgentSession(db, conversationId, agentId);
        } catch {
          // Clearing is best-effort; a failed delete only costs one extra failed turn
        }
      }
    }

    // 3) A finished turn may have (re)written `output/final.mp4`: reconcile 成片库 with disk.
    //    Best-effort and off the SSE path — a slow ffprobe must never delay the run's end frame.
    try {
      const projectId = getConversationProjectId(db, conversationId);
      if (projectId) void syncProjectCut(db, dataDir, projectId, run.id).catch(() => undefined);
    } catch {
      // The list endpoint reconciles again, so a miss here is only a delay
    }
  };
  const { unsubscribe, terminal } = manager.subscribe(runId, (event) => {
    if (event.event === 'end' || event.event === 'error') persist();
  });
  if (terminal) { persist(); unsubscribe(); }
}
