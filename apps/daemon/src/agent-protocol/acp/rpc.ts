/** @module agent-protocol/acp/rpc
 * Ported verbatim from open-design acp/rpc.ts — JSON-RPC 2.0 sending, error shape parsing,
 * usage normalization, permission option selection. Strips the opencode-specific promoted payload.
 */

import { asObject, type JsonObject } from './json.js';

export type JsonRpcId = number | string;
export interface RpcWritable {
  write(chunk: string): unknown;
}

/** Write one JSON-RPC request frame line. */
export function sendRpc(writable: RpcWritable, id: JsonRpcId, method: string, params: unknown): void {
  writable.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

/** Write back one JSON-RPC result frame line (used to answer a request_permission sent by the agent). */
export function sendRpcResult(writable: RpcWritable, id: JsonRpcId, result: unknown): void {
  writable.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

export function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

/** Take the human-readable error message from a JSON-RPC response; returns '' for non-error frames. */
export function rpcErrorMessage(raw: unknown): string {
  const obj = asObject(raw);
  const error = asObject(obj?.error);
  if (!obj || !error) {
    return '';
  }
  const message =
    typeof error.message === 'string'
      ? error.message
      : typeof error.code === 'number'
        ? String(error.code)
        : 'json-rpc error';
  return typeof obj.id === 'number' ? `json-rpc id ${obj.id}: ${message}` : message;
}

/** Get the structured error.data payload. */
export function rpcErrorData(raw: unknown): unknown {
  const obj = asObject(raw);
  const error = asObject(obj?.error);
  return error && 'data' in error ? error.data : undefined;
}

/**
 * Read an explicit retryable declaration from upstream. `retryable` (an ACP protocol field) is honored
 * in both directions; the vendor `isRetryable` is honored only when true — never let a coarse-grained
 * SDK flag force false and short-circuit what may be a more accurate answer in the message text.
 */
export function rpcErrorRetryable(data: unknown): boolean | undefined {
  const details = asObject(data);
  if (typeof details?.retryable === 'boolean') return details.retryable;
  if (details?.isRetryable === true) return true;
  return undefined;
}

/**
 * Infer from the message/details text when there is no explicit retryable field:
 * request_too_large (the prompt must shrink) is not retryable; upstream transport jitter
 * (stream idle timeout / overloaded / gateway failure) is retryable.
 * Returns undefined when neither matches, letting the caller keep its own default.
 */
export function inferRpcErrorRetryable(message: string, data: unknown): boolean | undefined {
  const details = asObject(data);
  const text = [message, details ? JSON.stringify(details) : ''].join('\n');
  if (/\b(request_too_large|request body exceeds configured limit)\b/i.test(text)) {
    return false;
  }
  if (
    /\b(upstream_error|stream idle timeout|no data received within configured window|temporarily unavailable|overloaded|gateway timeout|service unavailable)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/"is_?retryable"\s*:\s*true/i.test(text)) return true;
  return undefined;
}

/** Normalized token counts (snake_case, cache fields kept per family). */
export interface FormattedUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_read_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_input_tokens?: number;
  cached_write_tokens?: number;
  thought_tokens?: number;
  total_tokens?: number;
}

function firstFiniteNumber(src: JsonObject, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = src[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Normalize the usage in a session/prompt response (camelCase/snake_case are mixed).
 * cache fields are kept per family (Anthropic additive vs OpenAI inclusive), never folded together.
 */
export function formatUsage(usage: unknown): FormattedUsage | null {
  const src = asObject(usage);
  if (!src) return null;
  const out: FormattedUsage = {};
  const inputTokens = firstFiniteNumber(src, ['inputTokens', 'input_tokens']);
  const outputTokens = firstFiniteNumber(src, ['outputTokens', 'output_tokens']);
  const anthropicCacheRead = firstFiniteNumber(src, [
    'cache_read_input_tokens',
    'cacheReadInputTokens',
  ]);
  const openAiCacheRead = firstFiniteNumber(src, ['cachedReadTokens', 'cached_read_tokens']);
  const anthropicCacheCreation = firstFiniteNumber(src, [
    'cache_creation_input_tokens',
    'cacheCreationInputTokens',
  ]);
  const openAiCacheCreation = firstFiniteNumber(src, [
    'cacheCreationTokens',
    'cache_creation_tokens',
  ]);
  const openAiCachedWrite = firstFiniteNumber(src, ['cached_write_tokens', 'cachedWriteTokens']);
  const thoughtTokens = firstFiniteNumber(src, ['thoughtTokens', 'thought_tokens']);
  const totalTokens = firstFiniteNumber(src, ['totalTokens', 'total_tokens']);
  if (inputTokens !== undefined) out.input_tokens = inputTokens;
  if (outputTokens !== undefined) out.output_tokens = outputTokens;
  if (anthropicCacheRead !== undefined) out.cache_read_input_tokens = anthropicCacheRead;
  if (openAiCacheRead !== undefined) out.cached_read_tokens = openAiCacheRead;
  if (anthropicCacheCreation !== undefined) {
    out.cache_creation_input_tokens = anthropicCacheCreation;
  }
  if (openAiCacheCreation !== undefined) out.cache_creation_tokens = openAiCacheCreation;
  if (openAiCachedWrite !== undefined) out.cached_write_tokens = openAiCachedWrite;
  if (thoughtTokens !== undefined) out.thought_tokens = thoughtTokens;
  if (totalTokens !== undefined) out.total_tokens = totalTokens;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Permission reply option selection: approve_for_session > allow_always > allow_once.
 */
export function choosePermissionOutcome(options: unknown): string | null {
  const list = Array.isArray(options) ? options : [];
  const approveForSession = list.find(
    (option) => asObject(option)?.optionId === 'approve_for_session',
  );
  if (approveForSession) return 'approve_for_session';
  const allowAlways = list.find((option) => asObject(option)?.kind === 'allow_always');
  const allowAlwaysId = asObject(allowAlways)?.optionId;
  if (typeof allowAlwaysId === 'string') return allowAlwaysId;
  const allowOnce = list.find((option) => asObject(option)?.kind === 'allow_once');
  const allowOnceId = asObject(allowOnce)?.optionId;
  if (typeof allowOnceId === 'string') return allowOnceId;
  return null;
}
