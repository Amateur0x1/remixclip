/** @module agent-protocol/acp/json
 * Ported verbatim from open-design acp/json.ts — pure JSON access and text-walk helpers for ACP frames.
 * No side effects, no I/O.
 */

export type JsonObject = Record<string, unknown>;

/** Take message from an Error instance, String(err) otherwise. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Only non-null, non-array plain objects pass — the main guard before ACP-layer field access. */
export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/**
 * Recursively (max depth 4) pull out the first non-empty string, probing the usual text keys in order:
 * text / delta / content / message / output / answer / value / body / parts / choices.
 */
export function extractAcpTextValue(value: unknown, depth = 0): string | null {
  if (depth > 4) return null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => extractAcpTextValue(item, depth + 1))
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join('');
    return text.length > 0 ? text : null;
  }
  const obj = asObject(value);
  if (!obj) return null;
  for (const key of [
    'text',
    'delta',
    'content',
    'message',
    'output',
    'answer',
    'value',
    'body',
    'parts',
    'choices',
  ]) {
    const text = extractAcpTextValue(obj[key], depth + 1);
    if (text) return text;
  }
  return null;
}

/** Take the first non-empty text from the top-level keys of a session/update object (deep walk is left to extractAcpTextValue). */
export function extractAcpUpdateText(update: JsonObject): string | null {
  for (const key of [
    'content',
    'text',
    'delta',
    'message',
    'output',
    'answer',
    'value',
    'body',
    'parts',
    'choices',
  ]) {
    const text = extractAcpTextValue(update[key]);
    if (text) return text;
  }
  return null;
}

/** Take message/detail from the update as the human-readable detail of the status event. */
export function extractAcpStatusDetail(update: JsonObject): string | undefined {
  for (const key of ['message', 'detail']) {
    const value = update[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
