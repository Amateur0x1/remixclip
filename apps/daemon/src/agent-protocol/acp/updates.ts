/** @module agent-protocol/acp/updates
 * Tool lifecycle helpers ported from open-design acp/updates.ts —
 * status checks, kind whitelist, Claude-shaped tool name normalization, input/result construction,
 * ranked path extraction, think-only filtering. Strips DSML artifact suppression and Langfuse
 * telemetry redaction.
 */

import { asObject, extractAcpUpdateText, type JsonObject } from './json.js';

// ── Status checks ────────────────────────────────────────────────────────────

export function acpUpdateStatus(update: JsonObject): string {
  return typeof update.status === 'string' ? update.status.trim().toLowerCase() : '';
}

export function isAcpCompletedStatus(update: JsonObject): boolean {
  return acpUpdateStatus(update) === 'completed';
}

export function isAcpTerminalFailureStatus(update: JsonObject): boolean {
  const status = acpUpdateStatus(update);
  return status === 'failed' || status === 'error' || status === 'cancelled' || status === 'canceled';
}

export function isAcpTerminalToolStatus(update: JsonObject): boolean {
  return isAcpCompletedStatus(update) || isAcpTerminalFailureStatus(update);
}

// ── toolCallId / kind whitelist ──────────────────────────────────────────────

export function acpToolCallId(update: JsonObject): string | null {
  return typeof update.toolCallId === 'string' && update.toolCallId.trim()
    ? update.toolCallId.trim()
    : null;
}

/** kind words of the write/edit family. */
function isAcpWriteEditKind(kind: string): boolean {
  const token = kind.trim().toLowerCase();
  return (
    token === 'edit' ||
    token === 'write' ||
    token === 'create' ||
    token === 'patch' ||
    token === 'replace' ||
    token === 'update' ||
    token === 'save'
  );
}

/**
 * Whitelist of trusted kind families — these kinds are more reliable than title heuristics and may lock
 * the tool name across partial frames; unknown kinds (agents sometimes invent them) do not lock the name.
 */
export function isAcpRecognizedKind(kind: string): boolean {
  const token = kind.trim().toLowerCase();
  if (!token) return false;
  if (isAcpWriteEditKind(token)) return true;
  return (
    token === 'read' ||
    token === 'execute' ||
    token === 'bash' ||
    token === 'shell' ||
    token === 'terminal' ||
    token === 'search' ||
    token === 'grep' ||
    token === 'glob' ||
    token === 'think' ||
    token === 'thought' ||
    token === 'reason' ||
    token === 'reasoning' ||
    token === 'fetch' ||
    token === 'web' ||
    token === 'other'
  );
}

/**
 * Pure think/reason activity — not a concrete tool event, stays out of the tool_use/tool_result timeline
 * (thinking content goes through the agent_thought_chunk channel).
 */
export function isAcpThinkOnlyTool(update: JsonObject): boolean {
  const kind = typeof update.kind === 'string' ? update.kind.trim().toLowerCase() : '';
  if (kind === 'think' || kind === 'thought' || kind === 'reason' || kind === 'reasoning') {
    return true;
  }
  const name = typeof update.name === 'string' ? update.name.trim() : '';
  if (name && /^(think|thinking|thought|reason|reasoning)$/i.test(name)) {
    return true;
  }
  const title = typeof update.title === 'string' ? update.title.trim() : '';
  if (title && /^(think|thinking|thought|reason|reasoning)\b/i.test(title)) {
    return true;
  }
  return false;
}

/** Normalize a todowrite list snapshot (the vela/opencode bridge only puts the raw name into kind). */
export function isTodoWriteToolName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return name.trim().toLowerCase().replace(/[_\-\s]/g, '') === 'todowrite';
}

// ── Ranked path extraction (locations > rawInput > title) ────────────────────

export const ACP_PATH_RANK_LOCATIONS = 3;
export const ACP_PATH_RANK_RAW_INPUT = 2;
export const ACP_PATH_RANK_TITLE = 1;

export type AcpPathCandidate = { path: string; rank: number };
export type AcpPathOptions = { sessionCwd?: string | null };

const stripTrailingSeparators = (value: string): string =>
  value.length > 1 ? value.replace(/[\\/]+$/, '') : value;

/**
 * The write target must be a file — reject candidates provably being a directory:
 * 1. trailing separator or . / ..;
 * 2. same as the session cwd (opencode's shell fallback stuffs the session dir into locations);
 * 3. locations of execute-family tools (shell has no write target).
 */
function acpPathCandidateIsDirectory(
  path: string,
  source: number,
  update: JsonObject,
  options?: AcpPathOptions,
): boolean {
  if (/[\\/]$/.test(path)) return true;
  if (path === '.' || path === '..') return true;
  const sessionCwd = options?.sessionCwd;
  if (
    typeof sessionCwd === 'string' &&
    sessionCwd.trim() &&
    stripTrailingSeparators(path) === stripTrailingSeparators(sessionCwd.trim())
  ) {
    return true;
  }
  if (source === ACP_PATH_RANK_LOCATIONS) {
    const kind = typeof update.kind === 'string' ? update.kind.trim().toLowerCase() : '';
    if (kind === 'execute' || kind === 'bash' || kind === 'shell' || kind === 'terminal') {
      return true;
    }
  }
  return false;
}

/** Ranked path extraction; when partial frames are merged, a higher-priority source can upgrade a lower-priority path. */
export function acpToolPathRanked(
  update: JsonObject,
  options?: AcpPathOptions,
): AcpPathCandidate | null {
  // 1. locations: [{ path }] and content: [{ path }] (diff entries)
  for (const field of [update.locations, update.content]) {
    if (!Array.isArray(field)) continue;
    for (const entry of field) {
      const path = asObject(entry)?.path;
      if (typeof path === 'string' && path.trim()) {
        const trimmed = path.trim();
        if (acpPathCandidateIsDirectory(trimmed, ACP_PATH_RANK_LOCATIONS, update, options)) {
          continue;
        }
        return { path: trimmed, rank: ACP_PATH_RANK_LOCATIONS };
      }
    }
  }
  // 2. rawInput: path / file_path / filename / filePath
  const rawInput = asObject(update.rawInput);
  for (const key of ['path', 'file_path', 'filename', 'filePath']) {
    const value = rawInput?.[key];
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      if (acpPathCandidateIsDirectory(trimmed, ACP_PATH_RANK_RAW_INPUT, update, options)) {
        continue;
      }
      return { path: trimmed, rank: ACP_PATH_RANK_RAW_INPUT };
    }
  }
  // 3. a path-shaped filename token in the title (reject dotted identifiers like Image.open)
  const title = typeof update.title === 'string' ? update.title : '';
  const match = title.match(/[\w./\\-]+\.[A-Za-z0-9]+/);
  if (match?.[0] && isAcpPathLikeToken(match[0])) {
    return { path: match[0], rank: ACP_PATH_RANK_TITLE };
  }
  return null;
}

const ACP_PATH_LIKE_EXTENSIONS: ReadonlySet<string> = new Set([
  'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'mjs', 'cjs', 'md', 'mdx',
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'svg', 'png', 'jpg', 'jpeg', 'gif',
  'webp', 'avif', 'ico', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'pdf',
  'txt', 'csv', 'xml', 'py', 'go', 'rs', 'rb', 'php', 'sh', 'bash', 'zsh',
  'vue', 'svelte', 'astro', 'scss', 'less', 'map', 'wasm',
]);

/** The token looks like a filesystem path (not a dotted identifier like Image.open / f.read). */
export function isAcpPathLikeToken(token: string): boolean {
  const value = token.trim();
  if (!value) return false;
  if (value.startsWith('.') || value.includes('/') || value.includes('\\')) return true;
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return false;
  const ext = value.slice(dot + 1).toLowerCase();
  return ACP_PATH_LIKE_EXTENSIONS.has(ext);
}

// ── Tool name normalization ──────────────────────────────────────────────────

/** kind → stable Claude-shaped tool name. */
function acpToolNameFromKind(kind: string): string | null {
  const token = kind.trim().toLowerCase();
  if (!token) return null;
  if (token === 'edit' || token === 'patch' || token === 'replace' || token === 'update') {
    return 'Edit';
  }
  if (token === 'write' || token === 'create' || token === 'save') return 'Write';
  if (token === 'read') return 'Read';
  if (token === 'execute' || token === 'bash' || token === 'shell' || token === 'terminal') {
    return 'Bash';
  }
  if (token === 'search' || token === 'grep' || token === 'glob') return 'Grep';
  if (token === 'think' || token === 'thought' || token === 'reason' || token === 'reasoning') {
    return 'Think';
  }
  if (token === 'fetch' || token === 'web') return 'Fetch';
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** Derive the tool name from the human-readable title when both name/kind are missing. */
function acpToolNameFromTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  if (/\b(?:grep|search|glob)\b/i.test(trimmed)) return 'Grep';
  if (/\b(?:bash|shell|execute|terminal|run)\b/i.test(trimmed)) return 'Bash';
  if (/\bread\b/i.test(trimmed)) return 'Read';
  if (/\b(?:edit|patch|replace)\b/i.test(trimmed)) return 'Edit';
  if (/\b(?:write|create|save|update)\b/i.test(trimmed)) return 'Write';
  const first = trimmed.split(/\s+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/**
 * The free-text name of kind:other may carry paths/URLs/long sentences — keep only identifier-shaped ones
 * and collapse the rest to Other, so the user's private strings never reach the timeline.
 */
export function sanitizeAcpCustomToolName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return 'Other';
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('://') ||
    /\s/.test(trimmed) ||
    trimmed.length > 64
  ) {
    return 'Other';
  }
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(trimmed)) {
    return 'Other';
  }
  return trimmed;
}

/**
 * Normalize a stable Claude-shaped tool name from an ACP tool-call update.
 * A trusted kind family beats an explicit name and the title heuristics (kind:read + name:read_file
 * still normalizes to Read); kind:other is not a family, so an identifier-shaped name wins;
 * free-text names collapse to Other.
 */
export function acpToolName(update: JsonObject): string {
  const kindRaw = typeof update.kind === 'string' ? update.kind.trim() : '';
  const kindToken = kindRaw.toLowerCase();
  const recognizedKind = kindRaw ? isAcpRecognizedKind(kindRaw) : false;
  const kindName = kindRaw ? acpToolNameFromKind(kindRaw) : null;
  const kindIsCanonicalFamily = recognizedKind && kindToken !== 'other';

  // Recognize the list snapshot first, bypassing the heuristics (todowrite gets swallowed by the title heuristics)
  if (isTodoWriteToolName(kindRaw) || isTodoWriteToolName(update.name)) {
    return 'TodoWrite';
  }

  let name: string | null = null;
  if (kindIsCanonicalFamily && kindName) {
    name = kindName;
  } else if (typeof update.name === 'string' && update.name.trim()) {
    name = sanitizeAcpCustomToolName(update.name);
  } else if (recognizedKind && kindName) {
    name = kindName;
  } else if (typeof update.title === 'string' && update.title.trim()) {
    const fromTitle = acpToolNameFromTitle(update.title);
    name = fromTitle ? sanitizeAcpCustomToolName(fromTitle) : null;
  } else if (kindName) {
    name = kindName;
  }
  if (!name) name = 'Tool';
  return name;
}

// ── Input / result construction ──────────────────────────────────────────────

/**
 * Build Claude-shaped tool input: rawInput as the base, attach file_path once a real path is found;
 * never use toolCallId as the path.
 */
export function acpToolInput(
  update: JsonObject,
  options?: AcpPathOptions,
): Record<string, unknown> {
  const rawInput = asObject(update.rawInput);
  const input: Record<string, unknown> = rawInput ? { ...rawInput } : {};
  const path = acpToolPathRanked(update, options)?.path ?? null;
  if (path) {
    input.file_path = path;
  }
  if (Object.keys(input).length === 0) {
    if (typeof update.title === 'string' && update.title.trim()) {
      return { title: update.title.trim() };
    }
    return {};
  }
  return input;
}

/**
 * Extract the result text from a terminal tool-call update: rawOutput first, then text/diff content
 * entries; oversized payloads are truncated.
 */
export function acpToolResultContent(update: JsonObject, maxChars = 8000): string {
  const rawOutput = update.rawOutput;
  let text = '';
  if (typeof rawOutput === 'string') {
    text = rawOutput;
  } else if (rawOutput !== undefined && rawOutput !== null) {
    try {
      text = JSON.stringify(rawOutput);
    } catch {
      text = String(rawOutput);
    }
  } else if (Array.isArray(update.content)) {
    const parts: string[] = [];
    for (const entry of update.content) {
      const obj = asObject(entry);
      if (!obj) {
        if (typeof entry === 'string' && entry) parts.push(entry);
        continue;
      }
      if (typeof obj.text === 'string' && obj.text) {
        parts.push(obj.text);
        continue;
      }
      if (typeof obj.diff === 'string' && obj.diff) {
        parts.push(obj.diff);
        continue;
      }
      const oldText = typeof obj.oldText === 'string' ? obj.oldText : '';
      const newText = typeof obj.newText === 'string' ? obj.newText : '';
      if (oldText || newText) {
        parts.push(`--- old\n${oldText}\n+++ new\n${newText}`);
        continue;
      }
      const extracted = extractAcpUpdateText(obj);
      if (extracted) parts.push(extracted);
    }
    text = parts.join('\n');
  } else {
    text = extractAcpUpdateText(update) ?? '';
  }
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated]`;
}
