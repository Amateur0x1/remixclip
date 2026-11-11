/**
 * [INPUT]: loopback origins from OD_WEB_ORIGIN or the sidecar IPC `register-web-url` message.
 * [OUTPUT]: the set of browser origins allowed to call the daemon cross-origin.
 * [POS]: daemon-side registry replacing the old hardcoded '7457' allowlist.
 */
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Origins explicitly registered by the launcher (env) or by the web sidecar (IPC). */
const registeredOrigins = new Set<string>();

/**
 * Accepts only a bare loopback HTTP origin with an explicit port — the same
 * shape `normalizeRegisterWebUrlInput` enforces on the wire, so env seeding and
 * IPC registration cannot disagree.
 */
export function normalizeLoopbackOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:') return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  // `new URL('http://127.0.0.1:80').port` is '' — a missing port must not silently
  // become port 80, because every RemixClip origin carries an explicit port.
  if (parsed.port === '') return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return parsed.origin;
}

/** Registers `value` when it is a valid loopback origin; returns the normalized origin. */
export function registerWebOrigin(value: string): string | null {
  const origin = normalizeLoopbackOrigin(value);
  if (origin) registeredOrigins.add(origin);
  return origin;
}

export function isRegisteredWebOrigin(origin: string): boolean {
  return registeredOrigins.has(origin);
}

export function listWebOrigins(): string[] {
  return [...registeredOrigins].sort();
}

/**
 * Seeds the registry from a comma-separated `OD_WEB_ORIGIN`. tools-dev passes it
 * at spawn time so the daemon trusts the dev server before any IPC handshake.
 */
export function seedWebOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[SIDECAR_ENV.WEB_ORIGIN];
  if (!raw) return [];
  const added: string[] = [];
  for (const candidate of raw.split(',')) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const origin = registerWebOrigin(trimmed);
    if (origin) added.push(origin);
  }
  return added;
}

/** Test hook: drops every registration (env seeding is idempotent). */
export function resetWebOrigins(): void {
  registeredOrigins.clear();
}
