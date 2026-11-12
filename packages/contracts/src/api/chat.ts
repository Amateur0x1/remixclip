/**
 * Chat API types — aligned with the open-design runs protocol (trimmed).
 *
 * Flow: POST /api/runs -> { runId } -> GET /api/runs/:id/events (SSE)
 * SSE frames: start | agent | error | end
 */

// ── Conversations & messages ───────────────────────────────────────────────

/** An artifact file found by diffing the working-directory fingerprint before/after a run. */
export interface RunArtifact {
  /** Path relative to the session working directory (posix style). */
  path: string;
  change: 'created' | 'modified';
  /** Byte count. */
  size: number;
}

/**
 * How a working-directory file should be previewed. Derived from the extension in ONE place
 * (`workspaceFileKind`) so the daemon's tree endpoint and every web surface agree; a second
 * extension table elsewhere is how "the panel says image, the viewer says binary" bugs start.
 */
export type WorkspaceFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'html'
  | 'markdown'
  | 'text'
  | 'code'
  | 'pdf'
  | 'archive'
  | 'other';

const WORKSPACE_KIND_BY_EXT: Record<string, WorkspaceFileKind> = {
  // images
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.bmp': 'image',
  '.svg': 'image',
  // video
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.m4v': 'video',
  '.avi': 'video',
  // audio
  '.mp3': 'audio',
  '.wav': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  '.flac': 'audio',
  '.ogg': 'audio',
  // documents
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.log': 'text',
  '.csv': 'text',
  '.tsv': 'text',
  '.srt': 'text',
  '.vtt': 'text',
  '.pdf': 'pdf',
  // code
  '.json': 'code',
  '.json5': 'code',
  '.js': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.jsx': 'code',
  '.ts': 'code',
  '.tsx': 'code',
  '.css': 'code',
  '.scss': 'code',
  '.less': 'code',
  '.py': 'code',
  '.rb': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cpp': 'code',
  '.sh': 'code',
  '.zsh': 'code',
  '.bash': 'code',
  '.yaml': 'code',
  '.yml': 'code',
  '.toml': 'code',
  '.ini': 'code',
  '.xml': 'code',
  '.sql': 'code',
  // archives
  '.zip': 'archive',
  '.tar': 'archive',
  '.gz': 'archive',
  '.tgz': 'archive',
  '.7z': 'archive',
  '.rar': 'archive',
};

/** Classify a path (or a bare file name) by its extension; unknown extensions are `other`. */
export function workspaceFileKind(filePath: string): WorkspaceFileKind {
  const name = String(filePath ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return 'other';
  return WORKSPACE_KIND_BY_EXT[name.slice(dot)] ?? 'other';
}

/** One row of the conversation's project working directory. */
export interface WorkspaceEntry {
  /** Display name (no path). */
  name: string;
  /** POSIX path relative to the project working dir. */
  path: string;
  type: 'file' | 'dir';
  /** Bytes; 0 for directories. */
  size: number;
  mtimeMs: number;
  /** Files only — the previewer to use. */
  kind?: WorkspaceFileKind;
  /** Files only — best-effort MIME from the extension. */
  mime?: string;
}

/** Response of `GET /api/workspaces/:conversationId/tree?path=<rel>`. */
export interface WorkspaceTreeResponse {
  /** The listed directory, relative to the project working dir ('' = root). */
  path: string;
  entries: WorkspaceEntry[];
  /** True when the listing hit the per-directory entry cap. */
  truncated: boolean;
}

/** An image or file attachment uploaded by the user along with a message. */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Read-only access URL served by the daemon (/api/attachments/:id/:name). */
  url: string;
}

/** One tool call replayed from a finished turn. Inputs/outputs are capped by the daemon before
 *  they are stored, so a chatty command cannot bloat the message table. */
export interface ChatToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  /** Non-empty when the call happened inside a subagent (the parent Task call id). */
  parentToolUseId?: string;
  subagentType?: string;
  /** Text streamed by a subagent under this call. */
  liveText?: string;
}

/** One line of the turn's timeline, in arrival order. */
export type ChatTurnItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string };

/** A finished turn's process: what the agent ran and in which order it spoke/thought.
 *  Persisted beside the message so the collapsed chips survive a reload. */
export interface ChatTurnProcess {
  items: ChatTurnItem[];
  toolCalls: ChatToolCall[];
  /** Wall-clock duration of the run: the "Worked for …" row must survive a reload. */
  elapsedMs?: number;
  /**
   * The turn's failure, if it failed.
   *
   * Stored beside the message rather than in `content`: a quota exhaustion is not assistant prose,
   * and keeping it structured lets the reloaded history show the same error card (kind + reset
   * time) the live turn showed — instead of an extra paragraph of Chinese inside the bubble, or
   * nothing at all.
   */
  error?: ChatRunError;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  /** Author of an assistant message (which local agent produced it). Absent on user messages. */
  agentId?: string;
  content: string;
  createdAt: number;
  model?: string;
  runId?: string;
  /** Files produced by the run this message belongs to (assistant messages). */
  artifacts?: RunArtifact[];
  /** Images or files attached to this message (user messages). */
  attachments?: ChatAttachment[];
  /** Tool/thinking timeline of an assistant turn (replay only; live turns stream it separately). */
  process?: ChatTurnProcess;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** The project this conversation belongs to. 1:1: a project has exactly one conversation,
   *  so this id is interchangeable with the project's chat. */
  projectId: string;
}

// ── Agents ─────────────────────────────────────────────────────────────────

/** Fix action intent (trimmed version of open-design AgentFixIntent). */
export interface AgentFixAction {
  kind: 'rescan' | 'openInstall' | 'setEnv';
  /** setEnv only: the env var name to configure. */
  envKey?: string;
}

/** Structured diagnostic for a failed probe (trimmed version of open-design AgentDiagnostic):
 *  one-line reason + detail tooltip + clickable fix actions. */
export interface AgentDiagnostic {
  severity: 'error' | 'warn';
  message: string;
  detail?: string;
  /** Directories actually searched on PATH when the binary is missing (shown in the tooltip). */
  searchedDirs?: string[];
  fixActions: AgentFixAction[];
}

/**
 * A capability flag detected via `--help`.
 * id is the capability name normalized by the daemon (e.g. partialMessages); flag is the switch
 * that appears in the CLI help.
 * A new agent only needs a capabilityFlags entry in its def; no change to this union type here.
 */
export interface AgentCapability {
  id: string;
  flag: string;
}

/** Probe result of `authProbe` (e.g. `claude auth status`). */
export interface AgentAuthStatus {
  status: 'ok' | 'unauthenticated' | 'unknown';
  /** Raw output summary, shown as the diagnostic tooltip. */
  detail?: string;
}

/**
 * Last known quota/limit reading for one agent.
 *
 * The agents do not expose a uniform "show me my quota" command, but every one of them says so
 * when it runs out: the daemon classifies that failure and keeps the reading here, so the next
 * look at settings can answer "why did my last run die" without digging through any logs.
 */
export interface AgentQuotaStatus {
  status: 'ok' | 'exhausted' | 'unknown';
  /** One line for the settings row, e.g. "额度已用尽，预计 12:30 恢复". */
  detail?: string;
  /** When the exhausted quota is expected to reset (epoch ms), if the agent told us. */
  resetAt?: number | null;
  /** When this reading was observed (epoch ms). */
  checkedAt?: number;
  /** The most recent usage frame the agent reported (tokens / cost of one turn). */
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    at?: number;
  };
}

export interface AgentInfo {
  id: string;
  name: string;
  bin: string;
  available: boolean;
  version?: string;
  path?: string;
  /** Binary source: a standalone install on PATH, or a built-in CLI discovered inside an app bundle
   *  (e.g. the codex shipped with ChatGPT.app). */
  binSource?: 'path' | 'app-bundle';
  error?: string;
  /** Whitelist of env vars this agent supports configuring in settings. */
  envKeys?: string[];
  /** Structured diagnostic when unavailable (reason + fix actions). */
  diagnostic?: AgentDiagnostic;
  /** Optional list of suggested models (CLI aliases / model ids; users can still type their own). */
  models?: string[];
  /** Install docs link (target of the "install" button in the diagnostic row). */
  docsUrl?: string;
  /** Capability flags actually declared by `--help` (empty array when undetectable). */
  capabilities?: AgentCapability[];
  /** Auth probe result (absent when the def does not declare authProbe). */
  auth?: AgentAuthStatus;
  /** Last known quota reading (from a real run, not a paid probe). */
  quota?: AgentQuotaStatus;
}

/** Response of POST /api/test/connection: the daemon always answers 200,
 *  read ok/kind/detail for the outcome (trimmed version of open-design ConnectionTestResponse). */
export interface ConnectionTestResponse {
  ok: boolean;
  kind:
    | 'ok'
    | 'binary'
    | 'auth'
    | 'quota'
    | 'rate_limit'
    | 'network'
    | 'model'
    | 'timeout'
    | 'unknown';
  latencyMs: number;
  model?: string;
  detail?: string;
}

// ── Runs ───────────────────────────────────────────────────────────────────

export type ChatRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Why a run failed.
 *
 * The classification is the daemon's job: only it sees the agent's stderr / error frames, and an
 * agent CLI that exits 1 without telling anyone why must still become something the user can act
 * on. The web layer renders one card per kind instead of a bare "exit code 1".
 *
 *   quota     额度 / 配额 / 余额不足 —— 充值或等额度重置
 *   rate_limit 触发限流 —— 稍后重试
 *   auth      未登录 / 凭证失效 —— 在终端登录后重试
 *   network   网络 / 代理不可达
 *   agent     agent 自身报错（工具失败、模型拒绝等）
 *   unknown   实在看不出原因，保留原始输出供用户自查
 */
export type ChatRunErrorKind =
  | 'quota'
  | 'rate_limit'
  | 'auth'
  | 'network'
  | 'agent'
  | 'unknown';

/** Structured run failure carried by the SSE error frame and the run status endpoint. */
export interface ChatRunError {
  kind: ChatRunErrorKind;
  /** One-line summary; never just an exit code. */
  message: string;
  /** Raw agent output (stderr / error frame), shown in the expandable detail. */
  detail?: string;
  /** Process exit code — informational only. */
  exitCode?: number | null;
  /** Expected quota reset / retry-after time (epoch ms), when the agent said it. */
  retryAfterAt?: number | null;
}

export interface ChatRunCreateRequest {
  /** Runtime override for this turn; defaults to the global `app-config.agentId`. */
  agentId?: string;
  /**
   * This turn's user message (plain text, no transcript). The daemon owns context composition:
   * it either resumes the agent's upstream session or replays the conversation history, so the
   * caller must not pre-compose history itself — doing so duplicated context for resumed turns
   * and hid the "switched agent" case from the only layer that can decide it.
   */
  message: string;
  /** Latest user turn only (kept for title / persistence compatibility; defaults to message). */
  currentPrompt?: string;
  /**
   * Extra requirements for THIS turn only (the library's "补充要求").
   *
   * Injected into the prompt as its own section and never stored as message content: the
   * transcript keeps showing the plain brief the user sent, while the agent still receives the
   * constraints with priority over the base brief.
   */
  guidance?: string | null;
  /** The chat to run in. Omitted = the project's one conversation (created if the project has
   *  none yet), which is the normal case in the 1:1 model. */
  conversationId?: string | null;
  /** Project the turn runs in. Required when `conversationId` is omitted (created from it). */
  projectId?: string | null;
  model?: string | null;
  clientRequestId?: string | null;
  /** Images or files uploaded by the user with this turn's message. */
  attachments?: ChatAttachment[];
  /**
   * Whether to continue the upstream agent session of this conversation (session/load / --resume),
   * default true; pass false to force a brand-new session.
   */
  resume?: boolean;
  /**
   * UI language tag (`zh-CN` / `en`), so the agent answers in the user's interface language.
   * Not persisted: only applies to this turn's prompt, so switching language needs no session
   * rebuild.
   */
  locale?: string | null;
}

export interface ChatRunCreateResponse {
  runId: string;
  conversationId: string;
}

export interface ChatRunStatusResponse {
  id: string;
  status: ChatRunStatus;
  agentId: string;
  conversationId: string;
  createdAt: number;
  terminalAt?: number;
  exitCode?: number | null;
  error?: string;
  /** Structured failure (kind + detail + reset time); absent on successful runs. */
  runError?: ChatRunError;
  /** Artifact list derived from the working-directory diff after the run ends. */
  artifacts?: RunArtifact[];
  /**
   * Agent-side persistent session handle (captured at terminal state). The next run in the same
   * conversation can restore context from it (ACP session/load / claude --resume);
   * null = not supported by this agent.
   */
  sessionId?: string | null;
}

// ── SSE payloads ───────────────────────────────────────────────────────────

export interface ChatSseStartPayload {
  runId: string;
  agentId: string;
  bin: string;
  model?: string | null;
}

export type DaemonAgentPayload =
  | { type: 'status'; label: string; detail?: string }
  | { type: 'text_delta'; delta: string; parentToolUseId?: string }
  | { type: 'thinking_delta'; delta: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input?: unknown;
      /** Non-empty means this call happened inside some sub-agent (the id of its parent Task call). */
      parentToolUseId?: string;
      /** Task sub-agent type (input.subagent_type), only carried by Task calls. */
      subagentType?: string;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      content?: string;
      isError?: boolean;
      parentToolUseId?: string;
    }
  | {
      /** Call already issued, result not back yet (in-flight line of the ACP whole-frame protocol;
       *  same id as the terminal tool_use). */
      type: 'tool_in_flight';
      id: string;
      name: string;
      input?: unknown;
      output?: string;
      startedAt?: number;
    }
  | {
      type: 'usage';
      usage?: { inputTokens?: number; outputTokens?: number };
      costUsd?: number;
      durationMs?: number;
    }
  | { type: 'raw'; line: string };

export interface SseErrorPayload {
  /** Stable machine code: `quota_exceeded` / `rate_limited` / `auth_required` / `agent_error`. */
  code: string;
  message: string;
  /** Classification of the failure; absent only for transport-level errors. */
  kind?: ChatRunErrorKind;
  /** Raw agent output for the expandable detail. */
  detail?: string;
  /** Quota reset / retry-after time (epoch ms), when the agent said it. */
  retryAfterAt?: number | null;
  /** Process exit code — informational only. */
  exitCode?: number | null;
}

export interface ChatSseEndPayload {
  code: number | null;
  status: ChatRunStatus;
  conversationId: string;
  /** Artifact list derived from the working-directory diff after the run ends. */
  artifacts?: RunArtifact[];
  /** Agent-side persistent session handle (same as ChatRunStatusResponse.sessionId). */
  sessionId?: string | null;
}

export type SseTransportEvent<Name extends string, Payload> = {
  id?: number;
  event: Name;
  data: Payload;
};

export type RemixclipChatSseEvent =
  | SseTransportEvent<'start', ChatSseStartPayload>
  | SseTransportEvent<'agent', DaemonAgentPayload>
  | SseTransportEvent<'error', SseErrorPayload>
  | SseTransportEvent<'end', ChatSseEndPayload>;
