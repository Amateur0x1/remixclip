/**
 * [INPUT]: --daemon-port / --web-port flags plus the live daemon URL and Next dev
 *          port discovered before anything spawns.
 * [OUTPUT]: one PortPlan holding the daemon and web ports for this run.
 * [POS]: the single port authority, mirroring open-design's tools/dev
 *        `shared-ports.ts`: explicit flag -> live instance -> dynamic allocation.
 */
import { allocatePort, parsePortValue } from '@remixclip/sidecar';

export interface PortPlan {
  daemon: number;
  web: number;
}

export interface ResolvePortPlanInput {
  daemonPort?: number | string | null;
  webPort?: number | string | null;
  /** URL a live daemon reported over sidecar IPC; its port is reused as-is. */
  runningDaemonUrl?: string | null;
  /** Port of a live Next dev server for apps/web (Next 16 lock file). */
  runningWebPort?: number | null;
}

/** Port out of an http(s)/tcp URL, or null when the URL is absent/unparsable. */
export function portFromUrl(url: string | null | undefined): number | null {
  if (url == null) return null;
  try {
    const parsed = new URL(url);
    if (parsed.port.length > 0) {
      const port = Number(parsed.port);
      return Number.isInteger(port) && port > 0 ? port : null;
    }
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Resolve both ports once, before any child spawns. Precedence per app:
 * an explicit flag wins, then a live instance (its real port), then — for the daemon — the
 * extension-compatible default 7456 — then a dynamic allocation; `reserved` keeps the two apps
 * from ever receiving the same port.
 */
/**
 * Port the Chrome extension talks to until it is paired (see
 * extensions/remixclip-companion/src/lib/remixclip.ts). Dev prefers it so "开启自动连接" works
 * without the user hand-editing the extension's endpoint; a busy port falls back to a dynamic one.
 */
const PREFERRED_DAEMON_PORT = 7456;

export async function resolvePortPlan(input: ResolvePortPlanInput = {}): Promise<PortPlan> {
  const reserved = new Set<number>();

  const explicitDaemon = parsePortValue(input.daemonPort, 'daemon');
  const runningDaemonPort = portFromUrl(input.runningDaemonUrl);
  let daemon: number;
  if (explicitDaemon != null && explicitDaemon === runningDaemonPort) {
    daemon = explicitDaemon;
    reserved.add(daemon);
  } else if (explicitDaemon != null) {
    daemon = (await allocatePort({ label: 'daemon', port: explicitDaemon, reserved })).port;
  } else if (runningDaemonPort != null) {
    daemon = runningDaemonPort;
    reserved.add(daemon);
  } else {
    try {
      daemon = (await allocatePort({ label: 'daemon', port: PREFERRED_DAEMON_PORT, reserved })).port;
    } catch {
      daemon = (await allocatePort({ label: 'daemon', reserved })).port;
    }
  }

  const explicitWeb = parsePortValue(input.webPort, 'web');
  const runningWebPort = input.runningWebPort != null && input.runningWebPort > 0
    ? input.runningWebPort
    : null;
  let web: number;
  if (explicitWeb != null && explicitWeb === runningWebPort) {
    web = explicitWeb;
    reserved.add(web);
  } else if (explicitWeb != null) {
    web = (await allocatePort({ label: 'web', port: explicitWeb, reserved })).port;
  } else if (runningWebPort != null) {
    web = runningWebPort;
    reserved.add(web);
  } else {
    web = (await allocatePort({ label: 'web', reserved })).port;
  }

  return { daemon, web };
}
