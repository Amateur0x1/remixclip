/**
 * Agent detection — probe each registered CLI for availability + version.
 * Results are cached briefly so the UI can poll cheaply.
 *
 * Three-layer probe, all driven by def declarations (no hardcoded "which version supports what"):
 *   1. `versionArgs`  → availability + version (the only probe that decides available)
 *   2. `helpArgs` + `capabilityFlags` → capabilities: only flags present in help count as
 *      supported; results go into capabilityCache, and buildArgs uses them to decide flags
 *   3. `authProbe` → login state (one lightweight command, avoiding the 45s connectivity test)
 *
 * On probe failure a structured diagnostic is produced (open-design AgentDiagnostic pattern):
 * one-line reason + detail tooltip + clickable fix actions (rescan/install docs/configure env),
 * rendered by the frontend AgentDiagnosticRow.
 */

import { execFile } from 'node:child_process';
import { AGENT_DEFS } from './registry.js';
import { resolveAgentExecutable, agentSearchDirs } from './executables.js';
import { AGENT_CLI_ENV_KEYS, agentCliEnvForAgent, readAppConfig } from '../app-config.js';
import type { AgentAuthStatus, AgentCapability, AgentDiagnostic } from '@remixclip/contracts';
import type { DetectedAgent, RuntimeAgentDef } from './types.js';

const CACHE_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Help output can be long (dozens of flags); 512KB is plenty. */
const HELP_MAX_BYTES = 512 * 1024;
const AUTH_MAX_BYTES = 64 * 1024;

/** Common phrasing for "not logged in" (def can override via authProbe.unauthenticatedHints). */
const DEFAULT_AUTH_HINTS = [
  'not logged in',
  'not signed in',
  'login required',
  'please log in',
  'unauthenticated',
  'unauthorized',
  'no api key',
  'api key not',
  'invalid api key',
  'authentication required',
  'credentials not found',
  'token expired',
];

interface CommandProbe {
  /** Process exit code; null = failed to run (ENOENT etc.). */
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProbe(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBuffer: number,
): Promise<CommandProbe> {
  return new Promise((resolve) => {
    const child = execFile(
      binPath,
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, env },
      (error, stdout, stderr) => {
        const exitCode = error ? (error as { code?: unknown }).code : 0;
        resolve({
          code: typeof exitCode === 'number' ? exitCode : error ? null : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    // Some CLIs (e.g. `claude auth status`) wait on stdin when not a TTY: the probe must send EOF
    // right away, otherwise it only gets SIGKILLed at timeout with empty output.
    child.stdin?.end();
    child.on('error', () => resolve({ code: null, stdout: '', stderr: '' }));
  });
}

interface VersionProbe {
  version: string | null;
  stderr: string;
}

async function probeVersion(
  binPath: string,
  versionArgs: string[],
  env: NodeJS.ProcessEnv,
): Promise<VersionProbe> {
  const result = await runProbe(binPath, versionArgs, env, PROBE_TIMEOUT_MS, 64 * 1024);
  const out = `${result.stdout}${result.stderr}`.trim().split('\n')[0]?.trim();
  if (result.code !== 0 || !out) {
    return { version: null, stderr: `${result.stderr || result.stdout || '版本探测失败'}`.trim() };
  }
  return { version: out, stderr: '' };
}

/** Fetch the real runtime model list; returns null on failure/empty so callers fall back to static models. */
async function probeModels(
  def: RuntimeAgentDef,
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string[] | null> {
  const spec = def.listModels;
  if (!spec) return null;
  const result = await runProbe(
    binPath,
    spec.args,
    env,
    spec.timeoutMs ?? PROBE_TIMEOUT_MS,
    4 * 1024 * 1024,
  );
  if (result.code !== 0) return null;
  try {
    const models = spec.parse(result.stdout);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Probe result cache: capabilities + login state.
 * Only written on probe success; a failed probe stays "unknown"; unprobed agents (null) are
 * treated as supported in agentSupports, keeping argv consistent with the old behavior.
 */
const capabilityCache = new Map<string, ReadonlySet<string>>();
const authCache = new Map<string, AgentAuthStatus>();

/** Capabilities from the latest probe, used by runs / connection test to pick argv flags. */
export function agentCapabilities(agentId: string): ReadonlySet<string> | null {
  return capabilityCache.get(agentId) ?? null;
}

/**
 * Login state from the latest probe (null = never probed / def declares no authProbe).
 * Callers (connectivity test) only read the cache and never re-probe — probe cost stays on
 * /api/agents.
 */
export function agentAuthStatus(agentId: string): AgentAuthStatus | null {
  return authCache.get(agentId) ?? null;
}

interface CapabilityProbe {
  /** Whether help actually produced output; when false nothing is cached, so a failed probe is
   *  not mistaken for "not supported". */
  ok: boolean;
  capabilities: AgentCapability[];
}

async function probeCapabilities(
  def: RuntimeAgentDef,
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<CapabilityProbe> {
  const flags = def.capabilityFlags;
  if (!flags || Object.keys(flags).length === 0) return { ok: true, capabilities: [] };
  const result = await runProbe(
    binPath,
    def.helpArgs ?? ['--help'],
    env,
    PROBE_TIMEOUT_MS,
    HELP_MAX_BYTES,
  );
  const help = `${result.stdout}\n${result.stderr}`;
  if (!help.trim()) return { ok: false, capabilities: [] };
  const capabilities: AgentCapability[] = [];
  for (const [flag, id] of Object.entries(flags)) {
    if (help.includes(flag)) capabilities.push({ id, flag });
  }
  return { ok: true, capabilities };
}

async function probeAuth(
  def: RuntimeAgentDef,
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<AgentAuthStatus | null> {
  const probe = def.authProbe;
  if (!probe) return null;
  const result = await runProbe(
    binPath,
    probe.args,
    env,
    probe.timeoutMs ?? PROBE_TIMEOUT_MS,
    AUTH_MAX_BYTES,
  );
  const text = `${result.stdout}\n${result.stderr}`.trim();
  const detail = text ? text.split('\n').slice(0, 3).join(' ').slice(0, 300) : undefined;
  // Prefer the def's exact parser when present (e.g. the JSON from claude auth status).
  const classified = probe.classify?.({ code: result.code, stdout: result.stdout, output: text });
  if (classified) return classified;
  const lowered = text.toLowerCase();
  const hints = probe.unauthenticatedHints ?? DEFAULT_AUTH_HINTS;
  if (lowered && hints.some((hint) => lowered.includes(hint))) {
    return { status: 'unauthenticated', detail };
  }
  if (result.code === 0) return { status: 'ok', detail };
  // Non-zero without explicit wording: possibly an old version lacking that subcommand — do not
  // falsely report "not logged in".
  return { status: 'unknown', detail };
}

/** Binaries inside an app package (…/X.app/Contents/…) must be shown distinctly from PATH installs. */
function binSourceOf(binPath: string): 'path' | 'app-bundle' {
  return /\.app\/Contents\//.test(binPath) ? 'app-bundle' : 'path';
}

/** Missing-binary diagnostic: reason + searched dirs + fix actions (rescan / install / BIN override). */
function binaryMissingDiagnostic(def: RuntimeAgentDef): AgentDiagnostic {
  const fixActions: AgentDiagnostic['fixActions'] = [
    { kind: 'rescan' },
    ...(def.docsUrl ? [{ kind: 'openInstall' as const }] : []),
    ...(def.binEnvOverride ? [{ kind: 'setEnv' as const, envKey: def.binEnvOverride }] : []),
  ];
  const bundleHint = def.bundleBins?.length ? '或应用包内置路径（如 ChatGPT.app）' : '';
  return {
    severity: 'error',
    message: `未在 PATH${bundleHint} 中找到 ${def.bin} 可执行文件`,
    detail: 'PATH 检测过的目录见 tooltip；若已安装，可在设置中用 BIN 环境变量指定完整路径。',
    searchedDirs: agentSearchDirs(),
    fixActions,
  };
}

/** Diagnostic for a binary that exists but fails the version probe (often auth/network; the
 *  connectivity test can narrow it down). */
function versionFailedDiagnostic(def: RuntimeAgentDef, stderr: string): AgentDiagnostic {
  return {
    severity: 'warn',
    message: `已找到 ${def.bin}，但版本探测失败（可能是未登录或网络问题）`,
    ...(stderr ? { detail: stderr.slice(0, 400) } : {}),
    fixActions: [{ kind: 'rescan' }],
  };
}

export async function detectAgent(def: RuntimeAgentDef): Promise<DetectedAgent> {
  const envKeys = [...(AGENT_CLI_ENV_KEYS[def.id] ?? [])];
  const probeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...def.env,
    ...agentCliEnvForAgent(readAppConfig(), def.id),
  };
  const binPath = resolveAgentExecutable(def, probeEnv);
  if (!binPath) {
    capabilityCache.delete(def.id);
    authCache.delete(def.id);
    return {
      id: def.id,
      name: def.name,
      bin: def.bin,
      available: false,
      envKeys,
      ...(def.models ? { models: def.models } : {}),
      ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
      error: `未在 PATH 找到 ${def.bin}`,
      diagnostic: binaryMissingDiagnostic(def),
    };
  }

  const [probe, liveModels, capabilityProbe, auth] = await Promise.all([
    probeVersion(binPath, def.versionArgs, probeEnv),
    probeModels(def, binPath, probeEnv),
    probeCapabilities(def, binPath, probeEnv),
    probeAuth(def, binPath, probeEnv),
  ]);

  // Cache only when help actually produced output; otherwise stay "unknown" so argv is not
  // downgraded by a failed probe.
  if (capabilityProbe.ok) {
    if (capabilityProbe.capabilities.length > 0) {
      capabilityCache.set(def.id, new Set(capabilityProbe.capabilities.map((item) => item.id)));
    } else {
      capabilityCache.delete(def.id);
    }
  }
  if (auth && auth.status !== 'unknown') {
    authCache.set(def.id, auth);
  } else {
    authCache.delete(def.id);
  }

  const models = liveModels ?? def.models;
  return {
    id: def.id,
    name: def.name,
    bin: def.bin,
    available: probe.version != null,
    version: probe.version ?? undefined,
    path: binPath,
    binSource: binSourceOf(binPath),
    envKeys,
    ...(models && models.length > 0 ? { models } : {}),
    ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
    ...(capabilityProbe.ok ? { capabilities: capabilityProbe.capabilities } : {}),
    ...(auth ? { auth } : {}),
    ...(probe.version == null
      ? {
          error: '版本探测失败',
          diagnostic: versionFailedDiagnostic(def, probe.stderr),
        }
      : {}),
  };
}

let cache: { at: number; agents: DetectedAgent[] } | null = null;

export async function detectAgents(force = false): Promise<DetectedAgent[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.agents;
  }
  const agents = await Promise.all(AGENT_DEFS.map(detectAgent));
  cache = { at: Date.now(), agents };
  return agents;
}
