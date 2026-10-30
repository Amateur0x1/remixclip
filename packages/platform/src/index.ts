import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, openSync } from 'node:fs';
import { readFile, access, constants } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { request } from 'node:http';
import { APP_NAME } from '@remixclip/brand';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';

// ── Platform info ──────────────────────────────────────────────────────────

export interface PlatformInfo {
  os: NodeJS.Platform;
  arch: string;
}

export function getPlatformInfo(): PlatformInfo {
  return { os: process.platform, arch: process.arch };
}

// ── Command construction ───────────────────────────────────────────────────

export interface CommandInvocation {
  command: string;
  args: string[];
  options?: Record<string, unknown>;
}

export function createCommandInvocation(
  command: string,
  args: string[] = [],
  options?: Record<string, unknown>,
): CommandInvocation {
  return { command, args, options };
}

export function createPackageManagerInvocation(
  pmArgs: string[],
  cwd?: string,
): CommandInvocation {
  const pm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const args = [...pmArgs];
  return createCommandInvocation(pm, args, cwd ? { cwd } : undefined);
}

// ── Process management ─────────────────────────────────────────────────────

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdio?: 'pipe' | 'inherit' | 'ignore';
  signal?: AbortSignal;
  /** Append-mode log file; when set, stdout/stderr are redirected there (avoids EPIPE in detached procs) */
  logPath?: string;
}

export interface SpawnedProcess {
  process: ChildProcess;
  pid: number;
  stdoutPromise: Promise<string>;
  stderrPromise: Promise<string>;
}

export function spawnBackgroundProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): SpawnedProcess {
  const logFd = options.logPath ? openSync(options.logPath, 'a') : null;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: logFd != null ? ['ignore', logFd, logFd] : (options.stdio ?? 'pipe'),
    signal: options.signal,
    detached: true,
  });

  const stdoutCollect: Buffer[] = [];
  const stderrCollect: Buffer[] = [];

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer) => stdoutCollect.push(chunk));
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => stderrCollect.push(chunk));
  }

  const stdoutPromise = new Promise<string>((resolve) => {
    child.stdout?.on('end', () => resolve(Buffer.concat(stdoutCollect).toString('utf8')));
    child.stdout?.on('close', () => resolve(Buffer.concat(stdoutCollect).toString('utf8')));
  });

  const stderrPromise = new Promise<string>((resolve) => {
    child.stderr?.on('end', () => resolve(Buffer.concat(stderrCollect).toString('utf8')));
    child.stderr?.on('close', () => resolve(Buffer.concat(stderrCollect).toString('utf8')));
  });

  child.unref();
  return { process: child, pid: child.pid!, stdoutPromise, stderrPromise };
}

export function spawnLoggedProcess(
  command: string,
  args: string[] = [],
  options: SpawnOptions & { logPath?: string } = {},
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    stdio: options.stdio ?? 'pipe',
    signal: options.signal,
  });
  return child;
}

export function stopProcesses(processes: ChildProcess[], signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const proc of processes) {
    try {
      if (proc.pid != null && isProcessAlive(proc.pid)) {
        proc.kill(signal);
      }
    } catch {
      // ignore
    }
  }
}

// ── Process inspection ────────────────────────────────────────────────────

export function isProcessAlive(pid: number): boolean {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
}

export function captureProcessSnapshot(filter?: (pid: number) => boolean): Array<{ pid: number; cmd: string }> {
  try {
    const output =
      process.platform === 'darwin' || process.platform === 'linux'
        ? execSync('ps -eo pid,comm --no-headers', { encoding: 'utf8', maxBuffer: 1024 * 1024 })
        : '';
    const lines = output.trim().split('\n');
    const snapshots: Array<{ pid: number; cmd: string }> = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const pid = parseInt(parts[0]!, 10);
      if (!isNaN(pid) && (!filter || filter(pid))) {
        snapshots.push({ pid, cmd: parts.slice(1).join(' ') });
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

export function matchesProcessStamp(
  env: Record<string, string | undefined>,
  stamp: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(stamp)) {
    const envKey = `OD_SIDECAR_STAMP_${key.toUpperCase()}`;
    if (env[envKey] !== value) return false;
  }
  return true;
}

export function readProcessStamp(
  env: Record<string, string | undefined>,
): Record<string, string> | null {
  const stamp: Record<string, string> = {};
  const prefix = 'OD_SIDECAR_STAMP_';
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(prefix) && value) {
      stamp[key.slice(prefix.length).toLowerCase()] = value;
    }
  }
  return Object.keys(stamp).length > 0 ? stamp : null;
}

// ── Log reading ────────────────────────────────────────────────────────────

export async function readLogTail(
  logPath: string,
  nLines: number = 100,
): Promise<string[]> {
  if (!existsSync(logPath)) return [];
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(logPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    lines.push(line);
    if (lines.length > nLines) lines.shift();
  }
  return lines;
}

// ── File system ────────────────────────────────────────────────────────────

export async function atomicCopyFile(src: string, dest: string): Promise<void> {
  const destDir = path.dirname(dest);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  const { copyFile } = await import('node:fs/promises');
  await copyFile(src, dest);
}

export async function removePathBestEffort(filePath: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  try {
    await rm(filePath, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

export function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

export function waitForHttpOk(
  url: string,
  timeoutMs: number = 30_000,
  intervalMs: number = 500,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = (): void => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timeout waiting for ${url}`));
        return;
      }
      const req = request(url, { method: 'HEAD', timeout: 2000 }, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          resolve();
        } else {
          setTimeout(check, intervalMs);
        }
      });
      req.on('error', () => setTimeout(check, intervalMs));
      req.end();
    };
    check();
  });
}

export function mergeProxyAwareEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const proxyEnv: Record<string, string | undefined> = { ...env };
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
  if (httpProxy && !proxyEnv.HTTP_PROXY) proxyEnv.HTTP_PROXY = httpProxy;
  if (httpsProxy && !proxyEnv.HTTPS_PROXY) proxyEnv.HTTPS_PROXY = httpsProxy;
  return proxyEnv;
}

export function resolveSystemProxyEnv(): Record<string, string | undefined> {
  return {
    HTTP_PROXY: process.env.HTTP_PROXY ?? process.env.http_proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    NO_PROXY: process.env.NO_PROXY ?? process.env.no_proxy,
  };
}

// ── Toolchain discovery ────────────────────────────────────────────────────

export function wellKnownUserToolchainBins(): string[] {
  const paths: string[] = [];
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    paths.push(path.join(home, '.local', 'bin'));
    paths.push(path.join(home, 'bin'));
    if (process.platform === 'darwin') {
      paths.push(path.join(home, 'Library', 'Application Support', 'CatPaw IDE', 'cli-bin'));
    }
  }
  if (process.env.PATH) {
    paths.push(...process.env.PATH.split(path.delimiter));
  }
  return [...new Set(paths)];
}

// ── Sidecar data root helpers ──────────────────────────────────────────────

export function getDataRoot(namespace?: string): string {
  const ns = namespace || process.env[SIDECAR_ENV.NAMESPACE] || 'default';
  const base = process.env.XDG_DATA_HOME || path.join(process.env.HOME || '/tmp', '.local', 'share');
  return path.join(base, APP_NAME, ns);
}

export function ensureDataRoot(namespace?: string): string {
  const root = getDataRoot(namespace);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}