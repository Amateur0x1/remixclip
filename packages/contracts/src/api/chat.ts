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

/** An image or file attachment uploaded by the user along with a message. */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Read-only access URL served by the daemon (/api/attachments/:id/:name). */
  url: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  model?: string;
  runId?: string;
  /** Files produced by the run this message belongs to (assistant messages). */
  artifacts?: RunArtifact[];
  /** Images or files attached to this message (user messages). */
  attachments?: ChatAttachment[];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** The project this conversation belongs to. Every conversation has exactly one. */
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
}

/** Response of POST /api/test/connection: the daemon always answers 200,
 *  read ok/kind/detail for the outcome (trimmed version of open-design ConnectionTestResponse). */
export interface ConnectionTestResponse {
  ok: boolean;
  kind: 'ok' | 'binary' | 'auth' | 'network' | 'model' | 'timeout' | 'unknown';
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

export interface ChatRunCreateRequest {
  /** Runtime override for this turn; defaults to the global `app-config.agentId`. */
  agentId?: string;
  /** Full prompt text for the agent (already transcript-composed by caller). */
  message: string;
  /** Latest user turn only (used for conversation title / persistence). */
  currentPrompt?: string;
  conversationId?: string | null;
  /** Project the turn runs in; required when creating a conversation. */
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
  code: string;
  message: string;
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
