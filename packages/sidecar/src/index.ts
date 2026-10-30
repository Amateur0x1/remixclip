import { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { APP_NAME } from '@remixclip/brand';
import {
  APP_KEYS,
  type AppKey,
  type SidecarMode,
  type SidecarSource,
  type LegacySidecarRuntimeLayout as SidecarStamp,
  SIDECAR_DEFAULTS,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  SIDECAR_STAMP_FIELDS,
  SIDECAR_STAMP_FLAGS,
  type DaemonStatusSnapshot,
  type WebStatusSnapshot,
  type DesktopStatusSnapshot,
} from '@remixclip/sidecar-proto';
import {
  spawnBackgroundProcess,
  isProcessAlive,
  readLogTail,
  waitForHttpOk,
  getDataRoot,
  ensureDataRoot,
  type SpawnedProcess,
} from '@remixclip/platform';

// ── Re-export key types ────────────────────────────────────────────────────

export type {
  SidecarStamp,
  AppKey,
  SidecarMode,
  SidecarSource,
  DaemonStatusSnapshot,
  WebStatusSnapshot,
  DesktopStatusSnapshot,
};

export {
  APP_KEYS,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
  SIDECAR_DEFAULTS,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_STAMP_FLAGS,
};

// ── Types ──────────────────────────────────────────────────────────────────

export interface SidecarRequest {
  app: AppKey;
  channel?: string;
  mode?: SidecarMode;
  namespace?: string;
  source?: SidecarSource;
  port?: number;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface SpawnedSidecar {
  stamp: SidecarStamp;
  process: ChildProcess;
  pid: number;
}

export interface SidecarStatus {
  stamp: SidecarStamp;
  pid: number | null;
  running: boolean;
  url?: string;
  healthy: boolean;
}

export interface SidecarRestartResult {
  stopped: SpawnedSidecar | null;
  started: SpawnedSidecar;
}

export interface SidecarClientOptions {
  ipcPath: string;
  timeoutMs?: number;
}

// ── Stamp helpers ──────────────────────────────────────────────────────────

export function normalizeSidecarStamp(fields: Partial<SidecarStamp>): SidecarStamp {
  return {
    app: fields.app ?? APP_KEYS.DAEMON,
    mode: fields.mode ?? SIDECAR_MODES.DEV,
    namespace: fields.namespace ?? SIDECAR_DEFAULTS.namespace,
    ipc: fields.ipc ?? resolveIpcPath(fields.namespace),
    source: fields.source ?? SIDECAR_SOURCES.TOOLS_DEV,
  };
}

export function stampToArgs(stamp: SidecarStamp): string[] {
  return [
    SIDECAR_STAMP_FLAGS.app, stamp.app,
    SIDECAR_STAMP_FLAGS.ipc, stamp.ipc,
    SIDECAR_STAMP_FLAGS.mode, stamp.mode,
    SIDECAR_STAMP_FLAGS.namespace, stamp.namespace,
    SIDECAR_STAMP_FLAGS.source, stamp.source,
  ];
}

export function stampToEnv(stamp: SidecarStamp): Record<string, string> {
  return {
    [SIDECAR_ENV.BASE]: getSidecarBase(stamp),
    [SIDECAR_ENV.IPC_BASE]: stamp.ipc,
    [SIDECAR_ENV.IPC_PATH]: path.join(stamp.ipc, `${stamp.app}.sock`),
    [SIDECAR_ENV.NAMESPACE]: stamp.namespace,
    [SIDECAR_ENV.SOURCE]: stamp.source,
  };
}

export function stampKey(stamp: SidecarStamp): string {
  return `${stamp.namespace}/${stamp.app}/${stamp.mode}`;
}

function getSidecarBase(stamp: SidecarStamp): string {
  return path.join(getDataRoot(stamp.namespace), stamp.app, stamp.mode);
}

function resolveIpcPath(namespace?: string): string {
  const ns = namespace || 'default';
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${APP_NAME}-${ns}`
    : path.join('/tmp', APP_NAME, 'ipc', ns);
}

// ── Launch ─────────────────────────────────────────────────────────────────

let sidecarCounter = 0;

export function launchSidecar(request: SidecarRequest): SpawnedSidecar {
  const stamp = normalizeSidecarStamp({
    app: request.app,
    mode: request.mode ?? SIDECAR_MODES.DEV,
    namespace: request.namespace ?? SIDECAR_DEFAULTS.namespace,
    source: request.source ?? SIDECAR_SOURCES.TOOLS_DEV,
  });

  const base = getSidecarBase(stamp);
  ensureDataRoot(stamp.namespace);

  const logDir = path.join(base, 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const sidecarId = `sidecar-${stamp.app}-${++sidecarCounter}`;

  // Build the command to launch the app
  const { command, args } = resolveLaunchCommand(stamp, request);

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...stampToEnv(stamp),
    ...(request.port ? { [SIDECAR_ENV.DAEMON_PORT]: String(request.port) } : {}),
    ...(request.env || {}),
  };

  // daemon hosts the static web UI bundle. Defaults to apps/web/out inside the repo (dev layout),
  // but honors an OD_WEB_DIST_DIR already supplied by the caller (packaged: the web bundle
  // in the app resources directory).
  if (stamp.app === APP_KEYS.DAEMON && !env[SIDECAR_ENV.WEB_DIST_DIR]) {
    env[SIDECAR_ENV.WEB_DIST_DIR] = path.join(request.cwd || process.cwd(), 'apps', 'web', 'out');
  }

  // ELECTRON_RUN_AS_NODE=1 makes Electron start in plain Node mode (app/BrowserWindow
  // are all undefined). The var is inherited when desktop is launched from an Electron-based IDE
  // terminal, so strip it case-insensitively (same handling as open-design tools-dev).
  if (stamp.app === APP_KEYS.DESKTOP) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
    }
  }

  // Redirect stdout/stderr to log files (mirrors open-design openAppLog's
  // ['ignore', fd, fd] approach): otherwise the pipe breaks once the parent exits, the child
  // crashes with EPIPE on log writes, and swallowed stderr blocks debugging.
  // Read the logs via `tools-dev logs`.
  const spawned = spawnBackgroundProcess(command, args, {
    cwd: request.cwd,
    env,
    logPath: path.join(logDir, `${stamp.app}.log`),
  });

  return {
    stamp,
    process: spawned.process,
    pid: spawned.pid ?? -1,
  };
}

function resolveLaunchCommand(
  stamp: SidecarStamp,
  request: SidecarRequest,
): { command: string; args: string[] } {
  const baseDir = request.cwd || process.cwd();
  const distDir = path.join(baseDir, 'apps', stamp.app, 'dist');

  switch (stamp.app) {
    case APP_KEYS.DAEMON:
      return {
        command: 'node',
        args: [path.join(distDir, 'cli.js'), ...stampToArgs(stamp), ...(request.args ?? [])],
      };
    case APP_KEYS.WEB:
      // No stamp argv: next dev rejects unknown args. Identity travels via env (stampToEnv),
      // and process discovery matches on the command line
      // (open-design: apps don't see stamp flags).
      return {
        command: 'pnpm',
        args: ['--filter', '@remixclip/web', 'dev', ...(request.args ?? [])],
      };
    case APP_KEYS.DESKTOP:
      // Same as above: the electron main process does not parse stamp argv.
      return {
        command: 'pnpm',
        args: ['--filter', '@remixclip/desktop', 'start', ...(request.args ?? [])],
      };
    default:
      throw new Error(`unknown app key: ${stamp.app}`);
  }
}

// ── Stop ───────────────────────────────────────────────────────────────────

export async function stopSidecar(stamp: SidecarStamp): Promise<void> {
  const processes = findSidecarProcesses(stamp);
  for (const proc of processes) {
    if (proc.pid == null) continue;
    // detached spawn makes the child a process group leader: kill the group first
    // (killing desktop's pnpm wrapper also takes down its Electron child)
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-proc.pid!, sig);
      } catch {
        try {
          process.kill(proc.pid!, sig);
        } catch {
          // ignore
        }
      }
    };
    try {
      // Graceful shutdown via IPC
      try {
        await invokeSidecar(stamp, SIDECAR_MESSAGES.SHUTDOWN, undefined, { timeoutMs: 3000 });
      } catch {
        // fall through to kill
      }
      signal('SIGTERM');
      // Wait a bit then force kill
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (isProcessAlive(proc.pid)) {
        signal('SIGKILL');
      }
    } catch {
      // ignore
    }
  }
}

export async function stopSidecars(stamps: SidecarStamp[]): Promise<void> {
  await Promise.all(stamps.map((s) => stopSidecar(s)));
}

// ── Restart ────────────────────────────────────────────────────────────────

export async function restartSidecar(
  request: SidecarRequest,
  options?: { beforeStop?: () => Promise<void>; afterStart?: () => Promise<void> },
): Promise<SidecarRestartResult> {
  const stamp = normalizeSidecarStamp({
    app: request.app,
    namespace: request.namespace,
    source: request.source,
  });

  const existing = findSidecarProcesses(stamp);
  const stopped: SpawnedSidecar | null = existing.length > 0 && existing[0]!.pid != null
    ? { stamp, process: existing[0]!, pid: existing[0]!.pid }
    : null;

  if (stopped) {
    await options?.beforeStop?.();
    await stopSidecar(stamp);
  }

  const started = launchSidecar(request);
  await options?.afterStart?.();

  return { stopped, started };
}

// ── Process discovery ──────────────────────────────────────────────────────

import { execSync } from 'node:child_process';

export function findSidecarProcesses(stamp: SidecarStamp): ChildProcess[] {
  try {
    // `ps -axo pid=,command=` behaves the same on macOS (BSD) and Linux (GNU)
    // (empty header = no header row); `--no-headers` is GNU-only and errors on macOS.
    // Filtering happens in JS to avoid grep matching itself in a shell pipeline.
    const output =
      process.platform === 'darwin' || process.platform === 'linux'
        ? execSync('ps -axo pid=,command=', {
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: 3000,
          })
        : '';
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.includes(APP_NAME) &&
          line.includes(stamp.app) &&
          !line.includes('grep') &&
          // Exclude tools-dev itself (do NOT exclude on the 'tools-dev' substring —
          // the daemon's stamp arg --od-stamp-source tools-dev contains that word too)
          !/tools[\\/]dev[\\/](bin|dist)/.test(line),
      )
      .map((line) => {
        const pid = parseInt(line.split(/\s+/)[0]!, 10);
        if (isNaN(pid) || pid === process.pid || pid === process.ppid) return null;
        return { pid } as ChildProcess;
      })
      .filter(Boolean) as ChildProcess[];
  } catch {
    return [];
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

export function getSidecarStatus(stamp: SidecarStamp): SidecarStatus {
  const processes = findSidecarProcesses(stamp);
  const running = processes.length > 0;
  const pid: number | null = running && processes[0]?.pid != null ? processes[0]!.pid : null;
  return {
    stamp,
    pid,
    running,
    url: undefined,
    healthy: running,
  };
}

// ── IPC ────────────────────────────────────────────────────────────────────

export async function invokeSidecar<T>(
  stamp: SidecarStamp,
  type: string,
  input: unknown,
  options?: { timeoutMs?: number },
): Promise<T> {
  const ipcPath = stamp.ipc;
  return new Promise((resolve, reject) => {
    const client = net.createConnection(ipcPath, () => {
      const message = JSON.stringify({ type, input, stamp });
      client.write(message);
      client.end();
    });

    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error(`IPC timeout: ${type}`));
    }, options?.timeoutMs ?? 5000);

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
    });
    client.on('end', () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data) as T);
      } catch {
        resolve(data as unknown as T);
      }
    });
    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── SidecarClient ──────────────────────────────────────────────────────────

export class SidecarClient {
  private ipcPath: string;
  private timeoutMs: number;

  constructor(options: SidecarClientOptions) {
    this.ipcPath = options.ipcPath;
    this.timeoutMs = options.timeoutMs ?? 5000;
  }

  async status<T>(appKey: string, opts?: { timeoutMs?: number }): Promise<T | null> {
    const stamp = normalizeSidecarStamp({ app: appKey as AppKey });
    try {
      return await invokeSidecar<T>(stamp, SIDECAR_MESSAGES.STATUS, undefined, {
        timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      });
    } catch {
      return null;
    }
  }

  static connectInherited(
    env: Record<string, string | undefined>,
  ): SidecarClient | null {
    const ipcPath = env[SIDECAR_ENV.IPC_PATH];
    if (!ipcPath) return null;
    return new SidecarClient({ ipcPath });
  }
}

// ── Path resolution ────────────────────────────────────────────────────────

export function resolveSidecarBase(stamp: SidecarStamp): string {
  return getSidecarBase(stamp);
}

export function resolveNamespace(stamp: SidecarStamp): string {
  return stamp.namespace;
}

export function resolveAppRuntimeDir(stamp: SidecarStamp): string {
  return path.join(getSidecarBase(stamp), 'runtime');
}

export function resolveLogFilePath(stamp: SidecarStamp): string {
  return path.join(getSidecarBase(stamp), 'logs', `${stamp.app}.log`);
}

// ── Port allocation ────────────────────────────────────────────────────────

const BASE_PORT = 7456;
const portAllocations = new Map<string, number>();

export function allocatePort(request: { app: AppKey; offset?: number }): number {
  const key = request.app;
  if (portAllocations.has(key)) return portAllocations.get(key)!;
  const offset = request.offset ?? 0;
  const ports: Record<string, number> = {
    [APP_KEYS.DAEMON]: BASE_PORT + offset,
    [APP_KEYS.WEB]: BASE_PORT + 1 + offset,
    [APP_KEYS.DESKTOP]: BASE_PORT + 2 + offset,
  };
  const port = ports[request.app] ?? BASE_PORT + offset;
  portAllocations.set(key, port);
  return port;
}

// ── SidecarFactory (backward compat) ───────────────────────────────────────

export class SidecarFactory {
  static create(): SidecarFactory {
    return new SidecarFactory();
  }

  getPlatform(): string {
    return process.platform;
  }

  static connectInherited(env: Record<string, string | undefined>): SidecarClient | null {
    return SidecarClient.connectInherited(env);
  }
}

// ── Lifecycle lock ─────────────────────────────────────────────────────────

const lifecycleLocks = new Map<string, Promise<void>>();

export async function withSidecarLifecycleLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = lifecycleLocks.get(key);
  if (existing) await existing;
  const promise = fn().finally(() => lifecycleLocks.delete(key)) as Promise<void>;
  lifecycleLocks.set(key, promise);
  return fn();
}

// ── Bootstrap / Registration ───────────────────────────────────────────────

export function registerSidecarProcess(stamp: SidecarStamp): void {
  const base = getSidecarBase(stamp);
  ensureDataRoot(stamp.namespace);
  const stampFile = path.join(base, 'stamp.json');
  writeFileSync(stampFile, JSON.stringify(stamp, null, 2));
}

export function bootstrapSidecarProcess(stamp: SidecarStamp): void {
  registerSidecarProcess(stamp);
  // Set up IPC server
  const ipcDir = path.dirname(stamp.ipc);
  if (!existsSync(ipcDir)) mkdirSync(ipcDir, { recursive: true });
}

export function readCurrentSidecarStamp(env?: Record<string, string | undefined>): SidecarStamp | null {
  const e = env ?? process.env;
  const app = e[SIDECAR_ENV.BASE]?.split('/').slice(-2, -1)[0] as AppKey | undefined;
  if (!app) return null;
  return normalizeSidecarStamp({
    app,
    namespace: e[SIDECAR_ENV.NAMESPACE],
    source: e[SIDECAR_ENV.SOURCE] as SidecarSource,
    ipc: e[SIDECAR_ENV.IPC_BASE],
  });
}

export function isCurrentSidecarLauncher(env?: Record<string, string | undefined>): boolean {
  const e = env ?? process.env;
  return Boolean(e[SIDECAR_ENV.BASE]);
}

export function spawnSidecar(request: SidecarRequest): SpawnedSidecar {
  return launchSidecar(request);
}

export function spawnSidecarLauncher(request: SidecarRequest): SpawnedSidecar {
  return launchSidecar(request);
}

// ── Handoff ────────────────────────────────────────────────────────────────

export function handoffCurrentSidecarGeneration(_stamp: SidecarStamp): void {
  // no-op in dev; used in packaged mode to handoff generation token
}