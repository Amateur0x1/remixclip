import { cac } from 'cac';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_NAME } from '@remixclip/brand';
import {
  launchSidecar,
  stopSidecar,
  getSidecarStatus,
  allocatePort,
  normalizeSidecarStamp,
  type SpawnedSidecar,
  type SidecarStatus,
  APP_KEYS,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
} from '@remixclip/sidecar';
import {
  readLogTail,
  waitForHttpOk,
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

// ── start command ──────────────────────────────────────────────────────────

cli
  .command('start [app]', 'Start daemon/web/desktop (default: all)')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--daemon-port <port>', 'Daemon port override')
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToStart = app ? [appKey(app)] : allApps();

    const ports: Record<string, number> = {
      daemon: flags.daemonPort ? Number(flags.daemonPort) : allocatePort({ app: APP_KEYS.DAEMON }),
    };

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) {
        console.log(`[tools-dev] starting daemon on port ${ports.daemon}...`);
        const stamp = normalizeSidecarStamp({
          app: APP_KEYS.DAEMON,
          namespace,
          mode: SIDECAR_MODES.DEV,
          source: SIDECAR_SOURCES.TOOLS_DEV,
        });
        const sidecar = launchSidecar({
          app: APP_KEYS.DAEMON,
          namespace,
          port: ports.daemon,
          cwd: REPO_ROOT,
        });
        runningProcesses.set(APP_KEYS.DAEMON, sidecar);
        console.log(`[tools-dev] daemon started (pid ${sidecar.pid})`);

        // Wait for daemon to be ready
        try {
          await waitForHttpOk(`http://127.0.0.1:${ports.daemon}/api/`, 30000);
          console.log('[tools-dev] daemon ready');
        } catch {
          console.error('[tools-dev] daemon health check timed out (continuing)');
        }
      }

      if (a === APP_KEYS.WEB) {
        console.log('[tools-dev] starting web...');
        const stamp = normalizeSidecarStamp({
          app: APP_KEYS.WEB,
          namespace,
          mode: SIDECAR_MODES.DEV,
          source: SIDECAR_SOURCES.TOOLS_DEV,
        });
        const sidecar = launchSidecar({
          app: APP_KEYS.WEB,
          namespace,
          cwd: REPO_ROOT,
          env: { NEXT_PUBLIC_DAEMON_URL: `http://127.0.0.1:${ports.daemon}` },
        });
        runningProcesses.set(APP_KEYS.WEB, sidecar);
        console.log(`[tools-dev] web started (pid ${sidecar.pid})`);
        if (appsToStart.includes(APP_KEYS.DESKTOP)) {
          try {
            await waitForHttpOk('http://127.0.0.1:7457/', 30000);
            console.log('[tools-dev] web ready for Electron HMR');
          } catch {
            console.error('[tools-dev] web health check timed out (Electron will retry loading)');
          }
        }
      }

      if (a === APP_KEYS.DESKTOP) {
        console.log('[tools-dev] starting desktop (electron)...');
        const sidecar = launchSidecar({
          app: APP_KEYS.DESKTOP,
          namespace,
          // In dev it connects straight to Next; /api/* is proxied by Next to the daemon.
          port: ports.daemon,
          cwd: REPO_ROOT,
          env: { REMIXCLIP_WEB_DEV_URL: 'http://127.0.0.1:7457' },
        });
        runningProcesses.set(APP_KEYS.DESKTOP, sidecar);
        console.log(`[tools-dev] desktop started (pid ${sidecar.pid})`);
      }
    }

    console.log('[tools-dev] all requested services started');
  });

// ── run command (foreground) ───────────────────────────────────────────────

cli
  .command('run [app]', 'Run apps in foreground (Ctrl+C to stop)')
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  .option('--daemon-port <port>', 'Daemon port override')
  .action(async (app: string | undefined, flags: Record<string, unknown>) => {
    const namespace = String(flags.namespace || 'default');
    const appsToStart = app ? [appKey(app)] : allApps();

    const ports: Record<string, number> = {
      daemon: flags.daemonPort ? Number(flags.daemonPort) : allocatePort({ app: APP_KEYS.DAEMON }),
    };

    for (const a of appsToStart) {
      if (a === APP_KEYS.DAEMON) {
        console.log(`[tools-dev] running daemon on port ${ports.daemon}...`);
        const sidecar = launchSidecar({
          app: APP_KEYS.DAEMON,
          namespace,
          port: ports.daemon,
          cwd: REPO_ROOT,
        });
        runningProcesses.set(APP_KEYS.DAEMON, sidecar);
        console.log(`[tools-dev] daemon running (pid ${sidecar.pid})`);

        try {
          await waitForHttpOk(`http://127.0.0.1:${ports.daemon}/api/`, 30000);
          console.log('[tools-dev] daemon ready');
        } catch {
          console.error('[tools-dev] daemon health check timed out');
        }
      }

      if (a === APP_KEYS.WEB) {
        console.log('[tools-dev] running web...');
        const sidecar = launchSidecar({
          app: APP_KEYS.WEB,
          namespace,
          cwd: REPO_ROOT,
          env: { NEXT_PUBLIC_DAEMON_URL: `http://127.0.0.1:${ports.daemon}` },
        });
        runningProcesses.set(APP_KEYS.WEB, sidecar);
      }
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