import { cac } from 'cac';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@remixclip/brand';
import {
  launchSidecar,
  stopSidecar,
  getSidecarStatus,
  invokeSidecar,
  normalizeSidecarStamp,
  type SpawnedSidecar,
  type SidecarStatus,
  APP_KEYS,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  SIDECAR_MODES,
} from '@remixclip/sidecar';
import { portFromUrl, resolvePortPlan, type PortPlan } from './ports.js';
import {
  readLogTail,
  waitForHttpOk,
  isProcessAlive,
} from '@remixclip/platform';
import type { AppKey } from '@remixclip/sidecar-proto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** Built browser companion; the daemon zips this when the library's download button is used. */
const EXTENSION_DIST_DIR = path.join(REPO_ROOT, 'extensions', 'remixclip-companion', 'dist');

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

// ── Port plan & runtime discovery ──────────────────────────────────────────

function devStamp(app: AppKey, namespace: string) {
  return normalizeSidecarStamp({ app, namespace, mode: SIDECAR_MODES.DEV });
}

/**
 * URL a live daemon reported over sidecar IPC, or null when nothing answers.
 * This is the only way to learn a dynamically allocated port without guessing.
 */
async function lookupDaemonUrl(namespace: string): Promise<string | null> {
  const status = await getSidecarStatus(devStamp(APP_KEYS.DAEMON, namespace), { timeoutMs: 800 });
  return status.running && status.healthy ? (status.url ?? null) : null;
}

/** True when the Next dev server holding the project lock was launched by tools-dev. */
async function managedWebRunning(namespace: string): Promise<boolean> {
  if ((await readNextDevLock()) == null) return false;
  const status = await getSidecarStatus(devStamp(APP_KEYS.WEB, namespace), { timeoutMs: 300 });
  return status.running;
}

/**
 * Single source of truth for ports: decided once here and injected into every
 * child. Precedence is explicit flag > live instance > dynamic allocation, so a
 * restarting web joins the daemon that is already up instead of inventing a port.
 */
async function planRunPorts(flags: Record<string, unknown>, namespace: string): Promise<PortPlan> {
  const [runningDaemonUrl, lock] = await Promise.all([lookupDaemonUrl(namespace), readNextDevLock()]);
  try {
    return await resolvePortPlan({
      daemonPort: (flags.daemonPort as string | number | undefined) ?? null,
      webPort: (flags.webPort as string | number | undefined) ?? null,
      runningDaemonUrl,
      runningWebPort: lock?.port ?? null,
    });
  } catch (error) {
    return await abort(error instanceof Error ? error.message : String(error));
  }
}

async function startDaemonSidecar(
  plan: PortPlan,
  namespace: string,
  webPort: number | null,
  webWillRestart: boolean,
): Promise<void> {
  const existing = await getSidecarStatus(devStamp(APP_KEYS.DAEMON, namespace), { timeoutMs: 800 });
  if (existing.running) {
    const existingUrl = existing.url;
    const existingPort = portFromUrl(existingUrl);
    if (existingUrl == null || existingPort == null) {
      await abort(
        'a daemon process is already running for this namespace but does not answer on its control socket; run pnpm tools-dev stop first',
      );
      return;
    }
    if (existingPort !== plan.daemon) {
      await abort(
        `a daemon is already running at ${existingUrl}; stop it or pass --daemon-port ${existingPort}`,
      );
    }
    try {
      await waitForHttpOk(`${existingUrl}/api/`, 5_000);
      console.log(`[tools-dev] reusing daemon at ${existingUrl}`);
    } catch {
      await abort(`daemon at ${existingUrl} is unresponsive; run pnpm tools-dev stop daemon and start again`);
    }
    if (webPort != null) await registerWebOrigin(namespace, loopbackUrl(webPort));
    return;
  }

  const daemonUrl = loopbackUrl(plan.daemon);
  // A live web baked the old daemon port into its Next rewrites at boot; starting a
  // daemon on a new port would leave that web proxying into the void. Refuse instead
  // of silently drifting (same rule as open-design's restartDaemon).
  if (await managedWebRunning(namespace)) {
    if (!webWillRestart) {
      await abort(
        'web is still running against a daemon that is gone; run pnpm tools-dev stop web first, then start the daemon again',
      );
      return;
    }
    console.log('[tools-dev] stopping web that still points at the previous daemon...');
    await stopSidecar(devStamp(APP_KEYS.WEB, namespace));
  }
  console.log(`[tools-dev] starting daemon on port ${plan.daemon}...`);
  const sidecar = launchSidecar({
    app: APP_KEYS.DAEMON,
    namespace,
    port: plan.daemon,
     cwd: REPO_ROOT,
     // Daemon trusts this origin before the first browser request arrives.
     env: {
       // The built companion the library hands out; without it the daemon would guess the
       // repo layout, which only holds for a source checkout.
       [SIDECAR_ENV.EXTENSION_DIR]: EXTENSION_DIST_DIR,
       ...(webPort == null ? {} : { [SIDECAR_ENV.WEB_ORIGIN]: loopbackUrl(webPort) }),
     },
   });
  runningProcesses.set(APP_KEYS.DAEMON, sidecar);
  console.log(`[tools-dev] daemon started (pid ${sidecar.pid})`);
  try {
    await waitForHttpOk(`${daemonUrl}/api/`, 30_000);
    console.log(`[tools-dev] daemon ready at ${daemonUrl}`);
  } catch {
    await abort(
      `daemon health check failed (${daemonUrl}/api/ not ready within 30s); see pnpm tools-dev logs daemon`,
    );
  }
  if (webPort != null) await registerWebOrigin(namespace, loopbackUrl(webPort));
}

async function startWebSidecar(plan: PortPlan, namespace: string): Promise<void> {
  const webUrl = loopbackUrl(plan.web);
  const daemonUrl = loopbackUrl(plan.daemon);

  // Ordering is what keeps ports honest: web dials the daemon through the Next
  // rewrite proxy, so the daemon must already answer on the planned port.
  try {
    await waitForHttpOk(`${daemonUrl}/api/`, 3_000);
  } catch {
    await abort(`web needs a running daemon at ${daemonUrl}; start it first (pnpm tools-dev start daemon)`);
  }

  const lock = await readNextDevLock();
  if (lock) {
    if (lock.port !== plan.web) {
      await abort(
        `apps/web is already running on port ${lock.port} (pid ${lock.pid}); stop it or pass --web-port ${lock.port}`,
      );
    }
    // A Next dev server we did not spawn has its own NEXT_PUBLIC_DAEMON_URL baked
    // in at boot, so reusing it would silently proxy /api to a daemon that may be
    // gone. Only a web launched through this launcher is safe to adopt.
    if (!(await managedWebRunning(namespace))) {
      await abort(
        `apps/web already has a Next dev server on port ${lock.port} (pid ${lock.pid}) that tools-dev did not start; stop it first`,
      );
      return;
    }
    try {
      await waitForHttpOk(`${webUrl}/`, 5_000);
      console.log(`[tools-dev] reusing web at ${webUrl}`);
    } catch {
      await abort(`web at ${webUrl} is unresponsive; run pnpm tools-dev stop web and start again`);
    }
    await registerWebOrigin(namespace, webUrl);
    return;
  }

  console.log(`[tools-dev] starting web on port ${plan.web}...`);
  const sidecar = launchSidecar({
    app: APP_KEYS.WEB,
    namespace,
    cwd: REPO_ROOT,
    env: {
      // Next dev stops auto-incrementing once PORT is explicit (allowRetry=false),
      // so a collision fails hard instead of quietly binding web+1.
      PORT: String(plan.web),
      [SIDECAR_ENV.WEB_PORT]: String(plan.web),
      // The daemon origin the Next rewrite proxy dials; resolved once in the plan.
      [SIDECAR_ENV.DAEMON_PORT]: String(plan.daemon),
      NEXT_PUBLIC_DAEMON_URL: daemonUrl,
    },
  });
  runningProcesses.set(APP_KEYS.WEB, sidecar);
  console.log(`[tools-dev] web started (pid ${sidecar.pid})`);
  try {
    await waitForHttpOk(`${webUrl}/`, 30_000);
    console.log(`[tools-dev] web ready at ${webUrl}`);
  } catch {
    await abort(
      `web dev server health check failed (${webUrl}/ not ready within 30s); see pnpm tools-dev logs web`,
    );
  }
  await registerWebOrigin(namespace, webUrl);
}

async function startDesktopSidecar(
  plan: PortPlan,
  namespace: string,
  webStarting: boolean,
): Promise<void> {
  const lock = await readNextDevLock();
  const webPort = lock?.port ?? (webStarting ? plan.web : null);
  if (webPort == null) {
    await abort('desktop needs a running web dev server; start web first or pass --web-port');
    return;
  }
  console.log(`[tools-dev] starting desktop against ${loopbackUrl(webPort)}...`);
  const sidecar = launchSidecar({
    app: APP_KEYS.DESKTOP,
    namespace,
    // In dev it connects straight to Next; /api/* is proxied by Next to the daemon.
    cwd: REPO_ROOT,
    env: {
      REMIXCLIP_WEB_DEV_URL: loopbackUrl(webPort),
      [SIDECAR_ENV.WEB_PORT]: String(webPort),
      // The window still probes the daemon directly before its first paint, so it
      // needs the real port instead of the 7456 fallback baked into its main process.
      [SIDECAR_ENV.DAEMON_PORT]: String(plan.daemon),
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
    const plan = await planRunPorts(flags, namespace);
    const webStarting = appsToStart.includes(APP_KEYS.WEB);
    // Register only an origin that is actually (or about to be) serving the UI.
    const webPort = webStarting || (await managedWebRunning(namespace)) ? plan.web : null;

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) await startDaemonSidecar(plan, namespace, webPort, webStarting);
      if (a === APP_KEYS.WEB) await startWebSidecar(plan, namespace);
      if (a === APP_KEYS.DESKTOP) await startDesktopSidecar(plan, namespace, webStarting);
    }

    console.log(`[tools-dev] ports — daemon ${plan.daemon}, web ${plan.web}`);
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
    const plan = await planRunPorts(flags, namespace);
    const webStarting = appsToStart.includes(APP_KEYS.WEB);
    const webPort = webStarting || (await managedWebRunning(namespace)) ? plan.web : null;

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) await startDaemonSidecar(plan, namespace, webPort, webStarting);
      if (a === APP_KEYS.WEB) await startWebSidecar(plan, namespace);
      if (a === APP_KEYS.DESKTOP) await startDesktopSidecar(plan, namespace, webStarting);
    }

    console.log(`[tools-dev] ports — daemon ${plan.daemon}, web ${plan.web}`);

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
      const status = await getSidecarStatus(stamp, { timeoutMs: 500 });
      if (!status.running) {
        console.log(`[tools-dev] ${a} is not running`);
        continue;
      }
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
      results[a] = await getSidecarStatus(stamp, { timeoutMs: 800 });
    }

    if (outputJson) {
      const output: Record<string, unknown> = {};
      for (const [name, status] of Object.entries(results)) {
        output[name] = {
          running: status.running,
          pid: status.pid,
          healthy: status.healthy,
          url: status.url ?? null,
        };
      }
      console.log(JSON.stringify(output));
    } else {
      for (const [name, status] of Object.entries(results)) {
        const state = status.running
          ? `RUNNING (pid ${status.pid}${status.url ? ` at ${status.url}` : ''})`
          : 'STOPPED';
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
      const status = await getSidecarStatus(stamp, { timeoutMs: 800 });
      const state = status.running
        ? `✓ running (pid ${status.pid}${status.url ? ` at ${status.url}` : ' — no IPC answer'})`
        : '✗ stopped';
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