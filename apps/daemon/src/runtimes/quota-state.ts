/**
 * [INPUT]: quota / usage readings observed while running or testing a local agent.
 * [OUTPUT]: the last known quota reading per agent (`AgentQuotaStatus`), persisted to
 *           `<dataDir>/agent-quota.json` and served through `GET /api/agents`.
 * [POS]: The daemon's memory of "did this agent run out of quota, and when does it come back".
 *
 * Why not probe the providers directly
 * ------------------------------------
 * There is no uniform "show my quota" command across the supported CLIs, and probing with a real
 * prompt would itself cost quota. So the snapshot is *observed*, never guessed: it is written when
 * a run fails with a quota/rate-limit classification, when a usage frame arrives, or when a
 * successful run proves the agent is usable again.
 *
 * An exhaustion reading is time-boxed by its reset time: once that moment passes, the snapshot
 * degrades to `unknown` ("额度窗口应该已重置，可重试"), never to a confident `ok` — the daemon did
 * not actually ask anyone.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentQuotaStatus } from '@remixclip/contracts';

interface QuotaStoreShape {
  version: 1;
  agents: Record<string, AgentQuotaStatus>;
}

let storePath: string | null = null;
let cache: Record<string, AgentQuotaStatus> | null = null;

export function initQuotaState(dataDir: string): void {
  storePath = path.join(dataDir, 'agent-quota.json');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  cache = readStore(storePath);
}

function readStore(file: string): Record<string, AgentQuotaStatus> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as QuotaStoreShape;
    if (!parsed || parsed.version !== 1 || typeof parsed.agents !== 'object') return {};
    return parsed.agents ?? {};
  } catch {
    // A corrupted snapshot is not worth failing over — start clean.
    return {};
  }
}

function persist(): void {
  if (!storePath || !cache) return;
  try {
    const payload: QuotaStoreShape = { version: 1, agents: cache };
    writeFileSync(storePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Best-effort: the in-memory snapshot still serves this process.
  }
}

function ensureCache(): Record<string, AgentQuotaStatus> {
  if (!cache) cache = {};
  return cache;
}

/**
 * The current reading for one agent.
 *
 * A stale `exhausted` reading (reset time already passed) is downgraded in the returned copy only —
 * the stored value is kept so the settings row can still say when the last exhaustion happened.
 */
export function getQuota(agentId: string, now = Date.now()): AgentQuotaStatus {
  const stored = ensureCache()[agentId];
  if (!stored) return { status: 'unknown' };
  if (stored.status === 'exhausted' && stored.resetAt && stored.resetAt <= now) {
    return {
      ...stored,
      status: 'unknown',
      detail: `额度窗口应已重置（${formatClock(stored.resetAt)}），可重新尝试`,
    };
  }
  return stored;
}

/** Record that an agent ran out of quota / was throttled. */
export function recordQuotaExhausted(
  agentId: string,
  input: { detail?: string; resetAt?: number | null },
): AgentQuotaStatus {
  const next = ensureCache()[agentId] ?? {};
  const value: AgentQuotaStatus = {
    ...next,
    status: 'exhausted',
    checkedAt: Date.now(),
    resetAt: input.resetAt ?? null,
    detail:
      input.detail?.trim() ||
      (input.resetAt ? `额度已用尽，预计 ${formatClock(input.resetAt)} 恢复` : '额度已用尽'),
  };
  ensureCache()[agentId] = value;
  persist();
  return value;
}

/**
 * A run finished normally: the agent is usable again.
 *
 * Keeps `lastUsage` (that is per-turn history), clears the exhaustion state.
 */
export function recordQuotaOk(agentId: string): AgentQuotaStatus {
  const next = ensureCache()[agentId] ?? {};
  const value: AgentQuotaStatus = {
    ...next,
    status: 'ok',
    checkedAt: Date.now(),
    resetAt: null,
    detail: '最近一次运行正常',
  };
  ensureCache()[agentId] = value;
  persist();
  return value;
}

/** Remember the usage the agent reported for one turn (tokens / cost). */
export function recordUsage(
  agentId: string,
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number },
): void {
  if (usage.inputTokens == null && usage.outputTokens == null && usage.costUsd == null) {
    return;
  }
  const next = ensureCache()[agentId] ?? { status: 'unknown' as const };
  ensureCache()[agentId] = {
    ...next,
    lastUsage: { ...usage, at: Date.now() },
  };
  persist();
}

function formatClock(at: number): string {
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
