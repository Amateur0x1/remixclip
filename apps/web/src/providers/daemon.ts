/**
 * [INPUT]: the daemon's conversation, run and config HTTP APIs.
 * [OUTPUT]: typed chat requests, attachment uploads, error reporting and the SSE event stream.
 * [POS]: the web daemon client that drives the chat loop.
 */

import type {
  AgentInfo,
  ChatAttachment,
  ChatMessage,
  ChatRunCreateResponse,
  ChatRunStatusResponse,
  ChatSseEndPayload,
  ConnectionTestResponse,
  Conversation,
  CreateProjectResponse,
  DaemonAgentPayload,
  Project,
} from '@remixclip/contracts';
import { t } from '@/i18n';

// ── SSE frame parsing ──────────────────────────────────────────────────────

export interface SseFrame {
  id?: number;
  event: string;
  data: unknown;
}

export function parseSseFrame(raw: string): SseFrame | null {
  let event = 'message';
  let id: number | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim());
      if (!Number.isNaN(n)) id = n;
    } else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return null;
  try {
    return { id, event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

// ── Agents ─────────────────────────────────────────────────────────────────

export async function listAgents(refresh = false): Promise<AgentInfo[]> {
  const res = await fetch(`/api/agents${refresh ? '?refresh=1' : ''}`);
  if (!res.ok) throw new Error(t('errors.agentsHttp', { status: res.status }));
  const data = (await res.json()) as { agents: AgentInfo[] };
  return data.agents;
}

/** Connectivity test: the daemon always answers 200 with a ConnectionTestResponse; only network errors reject. */
export async function testConnection(
  agentId: string,
  model?: string,
): Promise<ConnectionTestResponse> {
  const res = await fetch('/api/test/connection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, model }),
  });
  if (!res.ok) {
    return {
      ok: false,
      kind: 'unknown',
      latencyMs: 0,
      detail: t('errors.daemonHttp', { status: res.status }),
    };
  }
  return (await res.json()) as ConnectionTestResponse;
}

// ── App config ─────────────────────────────────────────────────────────────

export interface AppConfigPrefs {
  agentId?: string;
  agentModels?: Record<string, string>;
  agentCliEnv?: Record<string, Record<string, string>>;
}

export async function fetchAppConfig(): Promise<AppConfigPrefs> {
  const res = await fetch('/api/app-config');
  if (!res.ok) throw new Error(t('errors.appConfigGetHttp', { status: res.status }));
  return (await res.json()) as AppConfigPrefs;
}

export async function putAppConfig(patch: Partial<AppConfigPrefs>): Promise<AppConfigPrefs> {
  const res = await fetch('/api/app-config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(t('errors.appConfigPutHttp', { status: res.status }));
  return (await res.json()) as AppConfigPrefs;
}

// ── Projects ───────────────────────────────────────────────────────────────

/** Every chat lives inside a project: name + instructions + a shared working dir. */
export async function listProjects(): Promise<Project[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) return [];
  const data = (await res.json()) as { projects: Project[] };
  return data.projects;
}

export async function createProject(input: {
  name?: string;
  customInstructions?: string | null;
  /** UI language tag: only used to title the seed conversation. */
  locale?: string;
}): Promise<CreateProjectResponse> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => null)) as
    | { project?: Project; conversation?: Conversation; error?: string }
    | null;
  if (!res.ok || !data?.project || !data.conversation) {
    throw new Error(data?.error ?? t('errors.createProject'));
  }
  return { project: data.project, conversation: data.conversation };
}

export async function updateProject(
  id: string,
  patch: { name?: string; customInstructions?: string | null },
): Promise<Project> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => null)) as { project?: Project; error?: string } | null;
  if (!res.ok || !data?.project) throw new Error(data?.error ?? t('errors.updateProject'));
  return data.project;
}

export async function deleteProject(id: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? t('errors.deleteProject'));
  }
}

// ── Conversations ──────────────────────────────────────────────────────────
// A conversation is always addressed through its project: there is no project-less chat.

/** Create a conversation inside a project. */
export async function createConversation(input: {
  title: string;
  projectId: string;
  /** UI language tag: only used by the daemon to pick the default title when it has none. */
  locale?: string;
}): Promise<Conversation> {
  const res = await fetch(`/api/projects/${encodeURIComponent(input.projectId)}/conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: input.title, locale: input.locale }),
  });
  const data = await res.json() as { conversation?: Conversation; error?: string };
  if (!res.ok || !data.conversation) throw new Error(data.error ?? t('errors.createConversation'));
  return data.conversation;
}

export async function listConversations(projectId: string): Promise<Conversation[]> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/conversations`);
  if (!res.ok) return [];
  const data = (await res.json()) as { conversations: Conversation[] };
  return data.conversations;
}

export async function listMessages(projectId: string, conversationId: string): Promise<ChatMessage[]> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { messages: ChatMessage[] };
  return data.messages;
}

export async function deleteConversation(projectId: string, conversationId: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? t('errors.deleteConversationHttp', { status: res.status }));
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const trimmed = url.trim();
  if (!trimmed) return;
  try {
    const res = await fetch('/api/open-external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: trimmed }),
    });
    if (res.ok) return;
  } catch {
    // fallback to window.open below
  }
  window.open(trimmed, '_blank', 'noopener,noreferrer');
}

// ── Runs & Attachments ─────────────────────────────────────────────────────

/** Read a browser File (pasted screenshot / file picker) as base64 and upload it to the daemon. */
export async function uploadAttachment(file: File): Promise<ChatAttachment> {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error(t('errors.readFile', { name: file.name })));
    reader.readAsDataURL(file);
  });
  const extByMime: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'application/pdf': '.pdf',
  };
  let name = file.name?.trim() || '';
  if (!name || name === 'image.png' || name === 'blob') {
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    const ext = extByMime[file.type] ?? '.png';
    name = `screenshot-${stamp}${ext}`;
  }
  const res = await fetch('/api/attachments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: file.type || 'application/octet-stream',
      dataBase64,
    }),
  });
  const data = (await res.json().catch(() => null)) as { attachment?: ChatAttachment; error?: string } | null;
  if (!res.ok || !data?.attachment) {
    throw new Error(data?.error ?? t('errors.uploadAttachmentHttp', { status: res.status }));
  }
  return data.attachment;
}

export interface CreateRunInput {
  /** Runtime override; omitted = the global app-config agent. */
  agentId?: string;
  message: string;
  currentPrompt: string;
  conversationId: string | null;
  projectId: string;
  model?: string | null;
  attachments?: ChatAttachment[];
  /** UI language tag: only tells the agent which language to answer in; not persisted. */
  locale?: string;
}

export async function createRun(input: CreateRunInput): Promise<ChatRunCreateResponse> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: input.agentId,
      message: input.message,
      currentPrompt: input.currentPrompt,
      conversationId: input.conversationId,
      projectId: input.projectId,
      model: input.model ?? null,
      attachments: input.attachments,
      locale: input.locale,
      clientRequestId: `web-${Date.now()}`,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? t('errors.createRunHttp', { status: res.status }));
  }
  return (await res.json()) as ChatRunCreateResponse;
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
}

export interface RunStreamHandlers {
  onStatus?: (label: string, detail?: string) => void;
  onTextDelta?: (delta: string, parentToolUseId?: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onToolUse?: (ev: Extract<DaemonAgentPayload, { type: 'tool_use' }>) => void;
  onToolResult?: (ev: Extract<DaemonAgentPayload, { type: 'tool_result' }>) => void;
  onToolInFlight?: (ev: Extract<DaemonAgentPayload, { type: 'tool_in_flight' }>) => void;
  onUsage?: (ev: { inputTokens?: number; outputTokens?: number; costUsd?: number }) => void;
  onError?: (message: string) => void;
  /** Full end-frame payload (including the run's artifact list). */
  onEnd?: (payload: ChatSseEndPayload) => void;
  /**
   * The transport-level reconnect event (mirrors open-design's DaemonStreamHandlers.onReconnect).
   * reconnect-state's state machine folds it into the reconnect row at the end of the transcript.
   */
  onReconnect?: (signal: {
    attempt: number;
    max: number;
    phase: 'reconnecting' | 'cleared' | 'exhausted';
  }) => void;
}

export const DAEMON_STREAM_RECONNECT_LIMIT = 3;

/**
 * Consume a run's SSE event stream. Supports ?after=<lastEventId> reconnection after a drop
 * (mirrors the core of open-design's consumeDaemonPhysicalRun).
 */
export async function streamRunEvents(
  runId: string,
  handlers: RunStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let lastEventId: number | undefined;
  let attempts = 0;

  while (attempts <= DAEMON_STREAM_RECONNECT_LIMIT) {
    attempts += 1;
    let sawTerminal = false;
    try {
      const url = `/api/runs/${runId}/events${lastEventId != null ? `?after=${lastEventId}` : ''}`;
      const res = await fetch(url, { signal, headers: { accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(t('errors.sseHttp', { status: res.status }));
      // Stream re-established: drop the reconnect row (once recovered the whole row disappears,
      // so no "recovered" state is left behind)
      if (attempts > 1) {
        handlers.onReconnect?.({
          attempt: attempts - 1,
          max: DAEMON_STREAM_RECONNECT_LIMIT,
          phase: 'cleared',
        });
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const raw of frames) {
          const frame = parseSseFrame(raw);
          if (!frame) continue;
          if (frame.id != null) lastEventId = frame.id;
          if (dispatchFrame(frame, handlers)) sawTerminal = true;
        }
      }
      // Stream ended normally (the daemon closes the connection once the run terminates)
      return;
    } catch (error) {
      if (signal?.aborted) return;
      if (sawTerminal) return;
      if (attempts > DAEMON_STREAM_RECONNECT_LIMIT) {
        // Attempts exhausted: report exhausted first (22-3 hands the button back to the user),
        // then the error. reconnect-state's state machine absorbs the failed that follows, so the
        // button does not flicker.
        handlers.onReconnect?.({
          attempt: DAEMON_STREAM_RECONNECT_LIMIT,
          max: DAEMON_STREAM_RECONNECT_LIMIT,
          phase: 'exhausted',
        });
        handlers.onError?.(
          error instanceof Error ? error.message : t('errors.sseInterrupted'),
        );
        return;
      }
      handlers.onReconnect?.({
        attempt: attempts,
        max: DAEMON_STREAM_RECONNECT_LIMIT,
        phase: 'reconnecting',
      });
      handlers.onStatus?.(t('chat.connLost'));
      await new Promise((resolve) => setTimeout(resolve, 500 * attempts));
    }
  }
}

/** @returns true when a terminal frame (end/error) was reached */
function dispatchFrame(frame: SseFrame, handlers: RunStreamHandlers): boolean {
  if (frame.event === 'start') {
    handlers.onStatus?.(t('chat.agentStarted'));
    return false;
  }
  if (frame.event === 'error') {
    const data = frame.data as { message?: string };
    handlers.onError?.(data.message ?? t('errors.unknown'));
    return true;
  }
  if (frame.event === 'end') {
    const data = frame.data as ChatSseEndPayload;
    handlers.onEnd?.(data);
    return true;
  }
  if (frame.event === 'agent') {
    const payload = frame.data as DaemonAgentPayload;
    switch (payload.type) {
      case 'status':
        handlers.onStatus?.(payload.label, payload.detail);
        break;
      case 'text_delta':
        handlers.onTextDelta?.(payload.delta, payload.parentToolUseId);
        break;
      case 'thinking_delta':
        handlers.onThinkingDelta?.(payload.delta);
        break;
      case 'tool_use':
        handlers.onToolUse?.(payload);
        break;
      case 'tool_result':
        handlers.onToolResult?.(payload);
        break;
      case 'tool_in_flight':
        handlers.onToolInFlight?.(payload);
        break;
      case 'usage':
        handlers.onUsage?.({
          inputTokens: payload.usage?.inputTokens,
          outputTokens: payload.usage?.outputTokens,
          costUsd: payload.costUsd,
        });
        break;
    }
  }
  return false;
}

// ── Transcript composition (a trimmed-down open-design buildDaemonTranscript) ──

export function buildTranscript(messages: ChatMessage[], currentPrompt: string): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const attNote = msg.attachments?.length
        ? t('errors.attachmentTranscript', { names: msg.attachments.map((a) => a.name).join(', ') })
        : '';
      parts.push(`## user\n${attNote}${msg.content}`);
    } else if (msg.role === 'assistant') {
      parts.push(`## assistant\n${msg.content}`);
    }
  }
  parts.push(`## user\n${currentPrompt}`);
  return parts.join('\n\n');
}

export type { ChatRunStatusResponse };
