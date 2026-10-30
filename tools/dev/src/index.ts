import { cac } from 'cac';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@remixclip/brand';
import {
  launchSidecar,
  stopSidecar,
  getSidecarStatus,
  allocatePort,
  isPortFree,
  invokeSidecar,
  normalizeSidecarStamp,
  type SpawnedSidecar,
  type SidecarStatus,
  APP_KEYS,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
} from '@remixclip/sidecar';
import {
  readLogTail,
  waitForHttpOk,
  isProcessAlive,
} from '@remixclip/platform';
import type { AppKey } from '@remixclip/sidecar-proto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const cli = cac('tools-dev');

// ── Utility ────────────────────────────────────────────────────────────────

const runningProcesses: Map<string, SpawnedSidecar> = new Map();

function appKey(input: string): AppKey {
  if (input === 'daemon' || input === 'web' || input === 'desktop') {
    return input as AppKey;
  }
  throw new Error(`unknown app: ${input}. Expected daemon, web, or desktop`);
}

function allApps(): AppKey[] {
  return [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP];
}

function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Stops everything this process started, then exits non-zero. */
async function abort(reason: string): Promise<never> {
  console.error(`[tools-dev] ${reason}`);
  if (runningProcesses.size === 0) process.exit(1);
  console.error('[tools-dev] rolling back: stopping processes started by this run...');
  for (const [name, proc] of [...runningProcesses.entries()].reverse()) {
    console.error(`[tools-dev] stopping ${name}...`);
    try {
      await stopSidecar(proc.stamp);
    } catch {
      try {
        proc.process.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  runningProcesses.clear();
  process.exit(1);
}

async function requirePortFree(port: number, hint: string): Promise<void> {
  if (await isPortFree(port)) return;
  await abort(`port ${port} is already in use: ${hint}`);
}

/**
 * Next 16 keeps a per-directory dev-server singleton (`apps/web/.next/dev/lock`).
 * A second `next dev` announces its port and then exits, so without this check
 * the launcher would wait the full health-check timeout for nothing.
 */
async function readNextDevLock(): Promise<{ pid: number; port: number } | null> {
  const distDir = process.env.NEXT_DIST_DIR || '.next';
  const lockPath = path.join(REPO_ROOT, 'apps', 'web', distDir, 'dev', 'lock');
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: number; port?: number };
    if (typeof parsed.pid === 'number' && isProcessAlive(parsed.pid)) {
      return { pid: parsed.pid, port: typeof parsed.port === 'number' ? parsed.port : 0 };
    }
  } catch {
    // No lock file, or it was left behind by a dead process.
  }
  return null;
}

/**
 * Tells an already-running daemon to trust the dev-server origin. `OD_WEB_ORIGIN`
 * covers a daemon we just spawned; this covers the split-start flow
 * (`start daemon` then `start web --web-port 7600`) where envs disagree.
 */
async function registerWebOrigin(namespace: string, origin: string): Promise<void> {
  const stamp = normalizeSidecarStamp({ app: APP_KEYS.DAEMON, namespace });
  try {
    await invokeSidecar(
      stamp,
      SIDECAR_MESSAGES.REGISTER_WEB_URL,
      { url: origin },
      { timeoutMs: 1000 },
    );
  } catch {
    // Daemon runs without a sidecar stamp (no IPC socket); env seeding covers it.
  }
}

// ── Port plan ──────────────────────────────────────────────────────────────

interface PortPlan {
  daemon: number;
  web: number;
}

/**
 * Single source of truth for ports: decided once here and injected into every
 * child. Nothing downstream re-derives or hardcodes a number.
 */
function resolvePortPlan(flags: Record<string, unknown>): PortPlan {
  return {
    daemon: flags.daemonPort ? Number(flags.daemonPort) : allocatePort({ app: APP_KEYS.DAEMON }),
    web: flags.webPort ? Number(flags.webPort) : allocatePort({ app: APP_KEYS.WEB }),
  };
}

async function startDaemonSidecar(plan: PortPlan, namespace: string): Promise<void> {
  const daemonUrl = loopbackUrl(plan.daemon);
  if (await isPortFree(plan.daemon)) {
    console.log(`[tools-dev] starting daemon on port ${plan.daemon}...`);
    const sidecar = launchSidecar({
      app: APP_KEYS.DAEMON,
      namespace,
      port: plan.daemon,
      cwd: REPO_ROOT,
      // Daemon trusts this origin before the first browser request arrives.
      env: { [SIDECAR_ENV.WEB_ORIGIN]: loopbackUrl(plan.web) },
    });
    runningProcesses.set(APP_KEYS.DAEMON, sidecar);
    console.log(`[tools-dev] daemon started (pid ${sidecar.pid})`);
    try {
      await waitForHttpOk(`${daemonUrl}/api/`, 30_000);
      console.log('[tools-dev] daemon ready');
    } catch {
      await abort(
        `daemon health check failed (${daemonUrl}/api/ not ready within 30s); see pnpm tools-dev logs daemon`,
      );
    }
  } else {
    // A daemon from an earlier run is fine (idempotent start); anything else
    // must not be mistaken for ours.
    try {
      await waitForHttpOk(`${daemonUrl}/api/`, 2_000);
      console.log(`[tools-dev] reusing daemon already listening on ${plan.daemon}`);
    } catch {
      await abort(
        `daemon port ${plan.daemon} is held by an unresponsive process; run pnpm tools-dev stop first, or pick another --daemon-port`,
      );
    }
  }
  // Covers the split-start flow where the daemon inherited a stale origin.
  await registerWebOrigin(namespace, loopbackUrl(plan.web));
}

async function startWebSidecar(plan: PortPlan, namespace: string): Promise<void> {
  const webUrl = loopbackUrl(plan.web);
  const lock = await readNextDevLock();
  if (lock) {
    await abort(
      `apps/web already has a Next dev server running (pid ${lock.pid}, ${loopbackUrl(lock.port)}) — Next 16 allows one per project directory; run pnpm tools-dev stop web or end that process first`,
    );
  }
  await requirePortFree(
    plan.web,
    `Next dev would silently move to ${plan.web + 1} and Electron would never load a page; free the port or pass --web-port`,
  );
  console.log(`[tools-dev] starting web on port ${plan.web}...`);
  const sidecar = launchSidecar({
    app: APP_KEYS.WEB,
    namespace,
    cwd: REPO_ROOT,
    env: {
      // Next dev stops auto-incrementing once -p/PORT is explicit (allowRetry=false),
      // so a collision fails hard instead of quietly binding web+1.
      PORT: String(plan.web),
      [SIDECAR_ENV.WEB_PORT]: String(plan.web),
      NEXT_PUBLIC_DAEMON_URL: loopbackUrl(plan.daemon),
    },
  });
  runningProcesses.set(APP_KEYS.WEB, sidecar);
  console.log(`[tools-dev] web started (pid ${sidecar.pid})`);
  try {
    await waitForHttpOk(`${webUrl}/`, 30_000);
    console.log('[tools-dev] web ready for Electron HMR');
  } catch {
    await abort(
      `web dev server health check failed (${webUrl}/ not ready within 30s); see pnpm tools-dev logs web`,
    );
  }
}

function startDesktopSidecar(plan: PortPlan, namespace: string): void {
  console.log('[tools-dev] starting desktop (electron)...');
  const sidecar = launchSidecar({
    app: APP_KEYS.DESKTOP,
    namespace,
    // In dev it connects straight to Next; /api/* is proxied by Next to the daemon.
    port: plan.daemon,
    cwd: REPO_ROOT,
    env: {
      REMIXCLIP_WEB_DEV_URL: loopbackUrl(plan.web),
      [SIDECAR_ENV.WEB_PORT]: String(plan.web),
    },
  });
  runningProcesses.set(APP_KEYS.DESKTOP, sidecar);
  console.log(`[tools-dev] desktop started (pid ${sidecar.pid})`);
}

// ── start command ──────────────────────────────────────────────────────────

cli
  .command('start [app]', 'Start daemon/web/desktop (default: all)')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--daemon-port <port>', 'Daemon port override')
  .option('--web-port <port>', 'Web dev server port override')
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToStart = app ? [appKey(app)] : allApps();
    const plan = resolvePortPlan(flags);

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) await startDaemonSidecar(plan, namespace);
      if (a === APP_KEYS.WEB) await startWebSidecar(plan, namespace);
      if (a === APP_KEYS.DESKTOP) startDesktopSidecar(plan, namespace);
    }

    console.log('[tools-dev] all requested services started');
  });

// ── run command (foreground) ───────────────────────────────────────────────

cli
  .command('run [app]', 'Run apps in foreground (Ctrl+C to stop)')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--daemon-port <port>', 'Daemon port override')
  .option('--web-port <port>', 'Web dev server port override')
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToStart = app ? [appKey(app)] : allApps();
    const plan = resolvePortPlan(flags);

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) await startDaemonSidecar(plan, namespace);
      if (a === APP_KEYS.WEB) await startWebSidecar(plan, namespace);
    }

    // Stay alive until Ctrl+C
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        console.log('\n[tools-dev] shutting down...');
        resolve();
      });
    });

    // Cleanup
    for (const [name, proc] of runningProcesses) {
      console.log(`[tools-dev] stopping ${name}...`);
      try {
        await stopSidecar(proc.stamp);
      } catch {
        // force kill
        proc.process.kill('SIGKILL');
      }
    }
    process.exit(0);
  });

// ── stop command ───────────────────────────────────────────────────────────

cli
  .command('stop [app]', 'Stop daemon/web/desktop (default: all)')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToStop = app ? [appKey(app)] : allApps();

    for (const a of appsToStop) {
      const stamp = normalizeSidecarStamp({
        app: a,
        namespace,
        mode: SIDECAR_MODES.DEV,
      });
      console.log(`[tools-dev] stopping ${a}...`);
      await stopSidecar(stamp);
      console.log(`[tools-dev] ${a} stopped`);
    }
  });

// ── status command ─────────────────────────────────────────────────────────

cli
  .command('status [app]', 'Check running status')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--json', 'Output JSON', { default: false })
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToCheck = app ? [appKey(app)] : allApps();
    const outputJson = Boolean(flags.json);

    const results: Record<string, SidecarStatus> = {};
    for (const a of appsToCheck) {
      const stamp = normalizeSidecarStamp({
        app: a,
        namespace,
        mode: SIDECAR_MODES.DEV,
      });
      results[a] = getSidecarStatus(stamp);
    }

    if (outputJson) {
      const output: Record<string, unknown> = {};
      for (const [name, status] of Object.entries(results)) {
        output[name] = {
          running: status.running,
          pid: status.pid,
          healthy: status.healthy,
        };
      }
      console.log(JSON.stringify(output));
    } else {
      for (const [name, status] of Object.entries(results)) {
        const state = status.running ? `RUNNING (pid ${status.pid})` : 'STOPPED';
        console.log(`${name.padEnd(10)} ${state}`);
      }
    }
  });

// ── logs command ───────────────────────────────────────────────────────────

cli
  .command('logs [app]', 'View log tail')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--lines <n>', 'Number of lines', { default: '50' })
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const nLines = Number(flags.lines) || 50;
    const appsToCheck = app ? [appKey(app)] : allApps();

    for (const a of appsToCheck) {
      const stamp = normalizeSidecarStamp({
        app: a,
        namespace,
        mode: SIDECAR_MODES.DEV,
      });
      const logPath = path.join(
        process.env.HOME || '/tmp',
        '.local', 'share', APP_NAME, namespace,
        a, 'dev', 'logs', `${a}.log`,
      );
      console.log(`\n=== ${a} (${logPath}) ===`);
      const lines = await readLogTail(logPath, nLines);
      for (const line of lines) {
        console.log(line);
      }
    }
  });

// ── Check command ──────────────────────────────────────────────────────────

cli
  .command('check [app]', 'Quick diagnostic')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToCheck = app ? [appKey(app)] : allApps();

    console.log(`[tools-dev] diagnostics (namespace: ${namespace}):`);
    for (const a of appsToCheck) {
      const stamp = normalizeSidecarStamp({
        app: a,
        namespace,
        mode: SIDECAR_MODES.DEV,
      });
      const status = getSidecarStatus(stamp);
      const state = status.running ? `✓ running (pid ${status.pid})` : '✗ stopped';
      console.log(`  ${a.padEnd(10)} ${state}`);
    }
  });

// ── Parse ──────────────────────────────────────────────────────────────────

cli.help();
cli.version('0.1.0');

// Bare `pnpm tools-dev` (or an unknown subcommand) defaults to `start`
// (daemon + web + desktop), matching open-design's rewriteCliArgsForDefaultStart convention.
// Note: cac parses the argv passed in (reassigning process.argv has no effect), so it must
// be passed explicitly.
const KNOWN_COMMANDS = new Set(['start', 'run', 'stop', 'status', 'logs', 'check', 'help']);
const rawArgs = process.argv.slice(2);
const firstPositional = rawArgs.find((a) => !a.startsWith('-'));
const effectiveArgs =
  !firstPositional || !KNOWN_COMMANDS.has(firstPositional)
    ? ['start', ...rawArgs]
    : rawArgs;

try {
  cli.parse([process.argv[0]!, process.argv[1]!, ...effectiveArgs]);
} catch (error) {
  console.error(`[tools-dev] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}