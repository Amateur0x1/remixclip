/**
 * [INPUT]: the process environment, the pnpm workspace root, and the host OS/CPU.
 * [OUTPUT]: resolved repo paths, normalized platform/arch types, a structured logger, and process/fs helpers.
 * [POS]: Shared foundation for every tools-pack command; no packaging decision lives here.
 */
import { execFileSync, type StdioOptions } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Platform = 'mac' | 'win' | 'linux';
export type Arch = 'arm64' | 'x64';

/** Walks up from any compiled file (src or tests) until the pnpm workspace marker is found. */
export function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`could not locate pnpm-workspace.yaml above ${start}`);
    }
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
export const APPS_DIR = path.join(REPO_ROOT, 'apps');
export const DESKTOP_DIR = path.join(APPS_DIR, 'desktop');
export const DAEMON_DIR = path.join(APPS_DIR, 'daemon');
export const WEB_DIR = path.join(APPS_DIR, 'web');
export const EXTENSION_DIR = path.join(REPO_ROOT, 'extensions', 'remixclip-companion');

export const DEFAULT_RELEASE_DIR = path.join(DESKTOP_DIR, 'release');
export const DEFAULT_STAGE_DIR = path.join(DESKTOP_DIR, '.release-stage');
export const DEFAULT_CACHE_DIR = path.join(DESKTOP_DIR, '.release-cache');
export const DEFAULT_NODE_VERSION = process.env.REMIXCLIP_NODE_VERSION || '24.18.0';

export const PRODUCT_NAME = 'RemixClip';

/**
 * Next writes the `output: 'export'` bundle into `distDir`, not into `out/`, as soon as a
 * custom distDir is used. Packaging therefore builds into an isolated dir (so a running
 * dev server keeps its own `.next`) and must read the export back from that same dir.
 */
export const WEB_BUILD_DIST_DIR = '.next-build';

/** Resolves the web static export to stage: the isolated build dir, else a plain `out/`. */
export function resolveWebExportDir(): string {
  const isolated = path.join(WEB_DIR, WEB_BUILD_DIST_DIR);
  if (existsSync(path.join(isolated, 'index.html'))) return isolated;
  return path.join(WEB_DIR, 'out');
}

export function normalizePlatform(value: string): Platform {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'host' || normalized === 'auto') return hostPlatform();
  if (normalized === 'mac' || normalized === 'darwin' || normalized === 'macos') return 'mac';
  if (normalized === 'win' || normalized === 'windows' || normalized === 'win32') return 'win';
  if (normalized === 'linux') return 'linux';
  throw new Error(`unsupported platform "${value}"; expected mac, win or linux`);
}

export function normalizeArch(value: string): Arch {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  if (normalized === 'x64' || normalized === 'amd64' || normalized === 'x86_64') return 'x64';
  throw new Error(`unsupported arch "${value}"; expected arm64 or x64`);
}

/**
 * Every spelling electron-builder may use for an arch in an artifact name. The linux
 * AppImage target emits `x86_64` where macOS and Windows emit `x64`, so verification and
 * cleanup must accept both instead of hard-coding one.
 */
export function archSpellings(arch: Arch): string[] {
  return arch === 'x64' ? ['x64', 'x86_64', 'amd64'] : ['arm64', 'aarch64'];
}

export function hostPlatform(): Platform {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  if (process.platform === 'linux') return 'linux';
  throw new Error(`unsupported host platform ${process.platform}`);
}

export function hostArch(): Arch {
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'x64') return 'x64';
  throw new Error(`unsupported host arch ${process.arch}`);
}

export function isWindowsHost(): boolean {
  return process.platform === 'win32';
}

export function hostMatches(platform: Platform, arch: Arch): boolean {
  return hostPlatform() === platform && hostArch() === arch;
}

// ── Logger ─────────────────────────────────────────────────────────────────
// Human output always goes to stderr so `--json` can keep stdout machine-only.

export interface Logger {
  readonly json: boolean;
  info(message: string): void;
  warn(message: string): void;
  step(message: string): void;
  child(message: string): void;
}

export function createLogger(json: boolean): Logger {
  const write = (prefix: string, message: string) => {
    process.stderr.write(`${prefix}${message}\n`);
  };
  return {
    json,
    info: (message) => write('', message),
    warn: (message) => write('warning: ', message),
    step: (message) => write('[tools-pack] ', message),
    child: (message) => write('[tools-pack] $ ', message),
  };
}

// ── Process ────────────────────────────────────────────────────────────────

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** Capture stdout (returned trimmed) instead of inheriting stdio. */
  capture?: boolean;
}

export function run(command: string, args: string[], options: RunOptions = {}): string {
  const { cwd = REPO_ROOT, env = process.env, logger, capture = false } = options;
  logger?.child([command, ...args].join(' '));
  // In `--json` mode child stdout is redirected to stderr so stdout stays machine-readable.
  const stdio: StdioOptions = capture
    ? ['ignore', 'pipe', 'inherit']
    : logger?.json
      ? ['ignore', 2, 2]
      : 'inherit';
  const stdout = execFileSync(command, args, {
    cwd,
    env,
    stdio,
    encoding: 'utf8',
    // `pnpm` is a .cmd shim on Windows and cannot be spawned without a shell.
    shell: isWindowsHost(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return typeof stdout === 'string' ? stdout.trim() : '';
}

/** Capture helper that returns null instead of throwing (used for optional git diagnostics). */
export function tryCapture(command: string, args: string[], cwd = REPO_ROOT): string | null {
  try {
    return run(command, args, { cwd, capture: true }) || null;
  } catch {
    return null;
  }
}

// ── Filesystem ─────────────────────────────────────────────────────────────

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function copyDir(from: string, to: string): void {
  removeDir(to);
  cpSync(from, to, { recursive: true, dereference: false });
}

/** Rounds bytes to a human-readable string for summaries. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
