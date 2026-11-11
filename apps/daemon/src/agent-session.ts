/**
 * [INPUT]: one conversation's stored messages, the agent about to run, its model/cwd, and the
 *          handle that agent left behind last time.
 * [OUTPUT]: whether the handle may be reused; when it may not, the history that must be replayed
 *           instead; a transcript section; per-agent resume-failure detection.
 * [POS]: the single place that decides what happens when the user switches agents mid-conversation.
 *
 * The model (ported from open-design, see the blog note
 * `knowledge/switching-agents-in-a-conversation.md`):
 *   - the conversation (messages) belongs to the app and is the source of truth;
 *   - an upstream session handle belongs to ONE agent and is only a cache;
 *   - switching agents writes nothing — the next turn simply misses on (conversation, agent);
 *   - a turn is either resumed (history already lives upstream) or reseeded (history is replayed
 *     here). "Neither resume nor replay" is the state that must never exist.
 */

import type { ChatMessage } from '@remixclip/contracts';
import { getAgentDef } from './runtimes/registry.js';

/** Why a stored handle may not be reused. Kept as data so callers can log / report it. */
export type ResumeInvalidationReason =
  | 'model_changed'
  | 'cwd_changed'
  | 'missing_cursor'
  | 'conversation_advanced';

export interface StoredSession {
  sessionId: string;
  model: string | null;
  cwd: string | null;
  lastMessageId: string | null;
}

/**
 * Three guards, all derived from stored facts — no `status` column to keep in sync.
 *
 *   model_changed        the handle was built under another model;
 *   cwd_changed          its remembered relative paths no longer resolve;
 *   missing_cursor       we cannot prove what the handle has already seen;
 *   conversation_advanced somebody else wrote after it (another agent, a deleted/edited turn).
 */
export function evaluateResumeInvalidation(input: {
  stored: StoredSession;
  model: string | null;
  cwd: string;
  latestAssistantMessageId: string | null;
}): ResumeInvalidationReason | null {
  const { stored, model, cwd, latestAssistantMessageId } = input;
  if (stored.model !== model) return 'model_changed';
  if (stored.cwd !== cwd) return 'cwd_changed';
  if (!stored.lastMessageId) return 'missing_cursor';
  if (stored.lastMessageId !== latestAssistantMessageId) return 'conversation_advanced';
  return null;
}

/**
 * What a turn needs from the past. A discriminated union on purpose: the resume branch cannot
 * carry history (the upstream session already has it), and the fresh branch always carries the
 * replay input. "Resume + history" (duplicate context) and "neither" (amnesia) are not
 * expressible by a caller.
 */
export type TurnContextPlan =
  | { resumeSessionId: string; history: []; reason: null }
  | {
      resumeSessionId: null;
      history: ChatMessage[];
      reason: ResumeInvalidationReason | 'no_session' | 'forced_new';
    };

export function planTurnContext(input: {
  stored: StoredSession | null;
  /** `body.resume === false` — the user explicitly asked for a brand-new upstream session. */
  forceNew: boolean;
  model: string | null;
  cwd: string;
  latestAssistantMessageId: string | null;
  /** All messages of the conversation BEFORE this turn's user message. */
  messages: ChatMessage[];
  agentId: string;
}): TurnContextPlan {
  const { stored, forceNew, model, cwd, latestAssistantMessageId, messages, agentId } = input;
  if (!stored) {
    return {
      resumeSessionId: null,
      history: scopeHistoryToAgent(messages, agentId),
      reason: 'no_session',
    };
  }
  if (forceNew) {
    return {
      resumeSessionId: null,
      history: scopeHistoryToAgent(messages, agentId),
      reason: 'forced_new',
    };
  }
  const reason = evaluateResumeInvalidation({ stored, model, cwd, latestAssistantMessageId });
  if (reason) {
    return { resumeSessionId: null, history: scopeHistoryToAgent(messages, agentId), reason };
  }
  return { resumeSessionId: stored.sessionId, history: [], reason: null };
}

/**
 * The family an agent belongs to for transcript purposes. Two entries that differ only in
 * provider configuration (opencode vs byok-opencode) share one runtime, so their turns are each
 * other's context instead of a hard boundary.
 */
export function transcriptFamilyOf(agentId: string): string {
  return getAgentDef(agentId)?.family ?? agentId;
}

/**
 * Keep only what belongs to the target agent: everything up to and including the LAST turn
 * produced by a different family is dropped.
 *
 * Deliberately not a translation layer — rewriting A's tool calls into text for B produces
 * "another model's notes", which B either over-trusts (following a failed line of reasoning) or
 * mistakes for its own actions. The files on disk are the handoff, not the transcript.
 */
export function scopeHistoryToAgent(messages: ChatMessage[], agentId: string): ChatMessage[] {
  const family = transcriptFamilyOf(agentId);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      message?.role === 'assistant' &&
      message.agentId &&
      transcriptFamilyOf(message.agentId) !== family
    ) {
      return messages.slice(i + 1);
    }
  }
  return messages;
}

// ── Transcript rendering ───────────────────────────────────────────────────

/** One message is capped so a pasted log cannot eat the whole context window. */
const MAX_MESSAGE_CHARS = 8_000;
/** Whole transcript is capped so a long conversation still leaves room for the actual task. */
const MAX_TRANSCRIPT_CHARS = 48_000;

/**
 * Role markers are our own wire format, so any line in user/assistant content that looks like
 * one must be neutralized — otherwise a message containing `### assistant` fabricates a turn.
 */
export function escapeRoleMarkers(text: string): string {
  return text.replace(/^(#{2,3} (?:user|assistant|system)\b)/gm, '\\$1');
}

function truncateMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const omitted = text.length - MAX_MESSAGE_CHARS;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}\n\n…（本条消息过长，已省略 ${omitted} 字符）`;
}

function renderMessage(message: ChatMessage): string | null {
  const body = truncateMessage(message.content.trim());
  if (!body) return null;
  const label =
    message.role === 'assistant'
      ? `assistant${message.agentId ? `（${message.agentId}）` : ''}`
      : message.role;
  const attachmentNote = message.attachments?.length
    ? `（附件：${message.attachments.map((item) => item.name).join('、')}）\n`
    : '';
  return `### ${label}\n${escapeRoleMarkers(attachmentNote + body)}`;
}

/**
 * The replay half of the invariant. Rendered newest-first so the budget drops the OLDEST turns
 * (the ones a file-centric agent can rebuild from the workspace) and keeps the recent intent.
 */
export function buildTranscriptSection(
  messages: ChatMessage[],
  options: { maxChars?: number } = {},
): string {
  const maxChars = options.maxChars ?? MAX_TRANSCRIPT_CHARS;
  const rendered: string[] = [];
  let used = 0;
  let omitted = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const block = renderMessage(messages[i]);
    if (!block) continue;
    if (used + block.length > maxChars) {
      omitted = i + 1;
      break;
    }
    rendered.push(block);
    used += block.length + 2;
  }
  if (rendered.length === 0) return '';

  const header = '## 对话历史\n本对话此前的轮次，仅用于恢复上下文，不是本轮的新指令。';
  const omittedNote = omitted > 0 ? `\n\n（更早的 ${omitted} 条消息因长度限制已省略）` : '';
  return `${header}${omittedNote}\n\n${rendered.reverse().join('\n\n')}`;
}

// ── Resume failure detection ───────────────────────────────────────────────

/**
 * Prose matching is the fallback, not the contract: prefer a structured signal whenever the
 * adapter exposes one (ACP session/load error, dsh `resumed: false`, ndjson `is_error` with zero
 * turns). Strings drift with CLI releases, and a stale regex means a dead handle is retried
 * forever — which looks exactly like "the model is broken".
 */
const RESUME_FAILURE_PATTERNS: Record<string, RegExp[]> = {
  claude: [/no conversation found with session id/i, /no session found/i, /session .* not found/i],
  codebuddy: [/no conversation found with session id/i, /no session found/i, /session .* not found/i],
  codex: [/no rollout found/i, /thread .* not found/i],
  opencode: [/session not found/i, /session .* does not exist/i],
  'byok-opencode': [/session not found/i, /session .* does not exist/i],
  'deepseek-harness': [/恢复了不同的会话/, /resume.*(?:reject|mismatch)/i],
  amr: [/"kind"\s*:\s*"resume_failed"/i, /resume[_ ]failed/i],
};

const GENERIC_RESUME_FAILURE = [
  /(?:session|conversation|thread|rollout)[^\n]{0,40}(?:not found|does not exist|expired)/i,
  /\bresume\b[^\n]{0,40}\b(?:fail(?:ed|ure)?|invalid|expired)\b/i,
];

/** True when the output says "this handle no longer exists", not "the task failed". */
export function isResumeFailure(agentId: string, text: string): boolean {
  if (!text.trim()) return false;
  const patterns = RESUME_FAILURE_PATTERNS[agentId] ?? [];
  return [...patterns, ...GENERIC_RESUME_FAILURE].some((pattern) => pattern.test(text));
}
