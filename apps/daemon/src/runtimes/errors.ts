/**
 * [INPUT]: raw text a local agent CLI printed (stderr, error frames, stdout tail) + its exit code.
 * [OUTPUT]: a structured ChatRunError (kind / message / detail / expected reset time).
 * [POS]: The single place that turns "agent exited 1" into something the user can act on.
 *
 * Why this exists
 * ---------------
 * Every CLI here reports a different thing when it dies, and some report nothing at all. The old
 * run manager only forwarded stderr's last three lines, so a quota exhaustion (the most common
 * real failure) surfaced as the useless string `agent 退出码 1`. The user cannot tell from that
 * whether to wait, log in, or fix their proxy.
 *
 * The classifier is deliberately keyword-based rather than per-adapter: agents change their
 * wording, and a new adapter should inherit this behaviour for free. Order matters — quota and
 * rate-limit readings are checked before the generic auth/network hints, because a 429 body often
 * mentions auth as well.
 */

import type { ChatRunError, ChatRunErrorKind } from '@remixclip/contracts';

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Quota / balance keywords. Chinese first (most of the supported CLIs are domestic), then the
 * English phrasings used by Claude Code, Codex, Gemini, Copilot and Cursor.
 */
const QUOTA_HINTS = [
  // 中文
  '额度不足',
  '额度已用完',
  '额度用尽',
  '额度已用尽',
  '额度耗尽',
  '额度已耗尽',
  '超出额度',
  '额度已超',
  '可用额度',
  '无可用额度',
  '免费额度',
  '今日额度',
  '额度将在',
  '额度恢复',
  '额度剩余',
  '余额不足',
  '配额不足',
  '配额已用尽',
  '超出配额',
  '配额超限',
  '已达上限',
  '达到限额',
  '用量已达',
  '资源包',
  // English
  'insufficient quota',
  'insufficient_quota',
  'quota exceeded',
  'quota_exceeded',
  'exceeded your current quota',
  'out of credits',
  'no credits',
  'insufficient credit',
  'credit balance is too low',
  'credit balance too low',
  'payment required',
  'exceeded your monthly',
  'exceeded your usage',
  'usage limit reached',
  'hit your usage limit',
  'hit your limit',
  "you've reached your",
  'reached your usage',
  'weekly limit',
  'monthly limit',
  'daily limit',
  'spending limit',
  'max budget',
  'budget exceeded',
  'out of usage',
  'usage quota',
  'limit will reset',
  'limit resets',
];

/** Transient throttling — retrying later is the right move, unlike quota exhaustion. */
const RATE_LIMIT_HINTS = [
  'rate limit',
  'rate_limit',
  'ratelimit',
  'too many requests',
  'throttled',
  'throttling',
  'resource_exhausted',
  'slow down',
  'try again later',
  '请求过于频繁',
  '请求太频繁',
  '访问过于频繁',
  '触发限流',
  '被限流',
  '限流中',
  '稍后重试',
];

/** Not signed in / dead credentials. */
const AUTH_HINTS = [
  'not logged in',
  'not signed in',
  'login required',
  'please log in',
  'please login',
  'please run /login',
  'run /login',
  'unauthenticated',
  'unauthorized',
  'invalid api key',
  'api key not',
  'incorrect api key',
  'authentication required',
  'authentication_error',
  'invalid bearer token',
  'credentials not found',
  'token expired',
  'session expired',
  '请先登录',
  '未登录',
  '登录已过期',
  '登录失效',
  '凭证失效',
  '401 unauthorized',
];

/** Transport-level failure. */
const NETWORK_HINTS = [
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'eai_again',
  'socket hang up',
  'fetch failed',
  'network error',
  'network is unreachable',
  'connect timeout',
  'connection timed out',
  'proxy',
  'tunnel',
  'dns',
  'certificate',
  'self signed certificate',
  'tls',
  '无法连接',
  '网络错误',
  '网络不可达',
  '连接超时',
];

export interface AgentFailureInput {
  /** Everything the agent said, already joined (stderr + error frames + stdout tail). */
  text: string;
  exitCode?: number | null;
  /** Display name of the agent, used in the generated one-liner. */
  agentName?: string;
  /** Binary name, so the auth/quota advice tells the user the exact command to run. */
  bin?: string;
  /** Injected for tests; defaults to Date.now(). */
  now?: number;
}

/** Kind-only classification; used by the connection test, which needs no message. */
export function classifyAgentFailureKind(text: string): ChatRunErrorKind {
  const lowered = stripAnsi(text).toLowerCase();
  if (!lowered.trim()) return 'unknown';
  if (QUOTA_HINTS.some((hint) => lowered.includes(hint))) return 'quota';
  if (RATE_LIMIT_HINTS.some((hint) => lowered.includes(hint))) return 'rate_limit';
  if (AUTH_HINTS.some((hint) => lowered.includes(hint))) return 'auth';
  if (NETWORK_HINTS.some((hint) => lowered.includes(hint))) return 'network';
  return 'unknown';
}

/**
 * Classify a failed run into a user-facing structure.
 *
 * `detail` keeps the raw agent text so the chat card can offer "show raw output" — the classifier
 * is best-effort, and an unclassified failure must still be debuggable.
 */
export function classifyAgentFailure(input: AgentFailureInput): ChatRunError {
  const now = input.now ?? Date.now();
  const text = stripAnsi(input.text).trim();
  const kind = classifyAgentFailureKind(text);
  const detail = summarizeDetail(text);
  const retryAfterAt = extractRetryAfterAt(text, now);
  const agent = input.agentName?.trim() || 'Agent';
  const bin = input.bin?.trim() || 'agent';
  const resetText = retryAfterAt ? `，预计 ${formatClock(retryAfterAt)} 恢复` : '';

  let message: string;
  switch (kind) {
    case 'quota':
      message =
        `额度不足：${agent} 的可用额度已用尽${resetText}。` +
        `请充值额度，或等待额度重置后再试；也可以在设置里切换到其他 Agent。`;
      break;
    case 'rate_limit':
      message =
        `请求过于频繁：${agent} 触发了限流${resetText}。` +
        `请稍后重试；若持续出现，可在设置里切换到其他 Agent。`;
      break;
    case 'auth':
      message = `未登录或凭证已失效：请先在终端运行 \`${bin}\` 完成登录，然后重试。`;
      break;
    case 'network':
      message =
        `网络不可达：无法连接 ${agent} 的服务。请检查网络、代理（HTTP(S)_PROXY）或 Base URL 配置后重试。`;
      break;
    case 'agent':
      message = detail
        ? `${agent} 运行失败：${firstLine(detail)}`
        : `${agent} 运行失败，未返回具体错误。`;
      break;
    default:
      message = input.exitCode != null
        ? `${agent} 运行失败（退出码 ${input.exitCode}），未返回可识别的错误信息。` +
          `可在终端直接运行 \`${bin}\` 复现，或展开下方原始输出查看。`
        : `${agent} 运行失败，未返回可识别的错误信息。可在终端直接运行 \`${bin}\` 复现。`;
      break;
  }

  return {
    kind,
    message,
    ...(detail ? { detail } : {}),
    exitCode: input.exitCode ?? null,
    retryAfterAt: retryAfterAt ?? null,
  };
}

/** Stable SSE code per kind (kept backwards compatible with the old `agent_error`). */
export function errorCodeOf(kind: ChatRunErrorKind): string {
  switch (kind) {
    case 'quota':
      return 'quota_exceeded';
    case 'rate_limit':
      return 'rate_limited';
    case 'auth':
      return 'auth_required';
    case 'network':
      return 'network_unreachable';
    default:
      return 'agent_error';
  }
}

function firstLine(text: string): string {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

/** Last ~1200 chars, ANSI stripped and blank runs collapsed — enough to diagnose, small enough
 *  for a chat bubble. */
function summarizeDetail(text: string): string | undefined {
  if (!text) return undefined;
  const collapsed = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line.trim() !== '' || all[index - 1]?.trim() !== '')
    .join('\n')
    .trim();
  if (!collapsed) return undefined;
  return collapsed.length > 1200 ? `…${collapsed.slice(-1200)}` : collapsed;
}

function formatClock(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

/**
 * Pull a reset / retry-after moment out of the agent's wording.
 *
 * Known shapes:
 *   Claude Code  `Claude AI usage limit reached|1730000000`
 *   HTTP-ish     `Retry-After: 3600`, `try again in 5 minutes`
 *   中文          `额度将在 30 分钟后恢复`
 *
 * Anything unparseable returns null, and the card simply omits the reset line — a wrong time is
 * worse than no time.
 */
export function extractRetryAfterAt(text: string, now = Date.now()): number | null {
  const MAX_AHEAD_MS = 31 * 24 * 60 * 60 * 1000;
  const clamp = (value: number): number | null => {
    if (!Number.isFinite(value)) return null;
    if (value <= now - 60_000) return null;
    return Math.min(value, now + MAX_AHEAD_MS);
  };

  // Claude Code: `usage limit reached|1730000000` (seconds; some builds emit ms)
  const epoch = text.match(/usage limit reached\s*\|\s*(\d{9,13})/i);
  if (epoch) {
    const raw = Number(epoch[1]);
    return clamp(raw < 1_000_000_000_000 ? raw * 1000 : raw);
  }

  // Explicit retry-after in seconds/minutes/hours
  const retryAfter = text.match(
    /retry[- ]after[:\s]+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)?/i,
  );
  if (retryAfter) {
    const amount = Number(retryAfter[1]);
    const unit = (retryAfter[2] ?? 's').toLowerCase();
    const ms = unit.startsWith('h')
      ? amount * 3_600_000
      : unit.startsWith('m')
        ? amount * 60_000
        : amount * 1000;
    return clamp(now + ms);
  }

  const tryAgain = text.match(
    /try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i,
  );
  if (tryAgain) {
    const amount = Number(tryAgain[1]);
    const unit = tryAgain[2].toLowerCase();
    const ms = unit.startsWith('h')
      ? amount * 3_600_000
      : unit.startsWith('m')
        ? amount * 60_000
        : amount * 1000;
    return clamp(now + ms);
  }

  // `resets at 2026-11-12T18:00:00Z`
  const iso = text.match(
    /reset[^0-9]{0,12}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)/i,
  );
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed)) return clamp(parsed);
  }

  // 中文相对时间：30 分钟后恢复 / 2 小时后重试 / 60 秒后
  const chinese = text.match(/(\d+(?:\.\d+)?)\s*(秒|分钟|小时)\s*(?:后|之后)/);
  if (chinese) {
    const amount = Number(chinese[1]);
    const unit = chinese[2];
    const ms = unit === '小时'
      ? amount * 3_600_000
      : unit === '分钟'
        ? amount * 60_000
        : amount * 1000;
    return clamp(now + ms);
  }

  return null;
}
