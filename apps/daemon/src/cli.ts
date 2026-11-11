#!/usr/bin/env node

import { cac } from 'cac';
import { startRemixclipServer, type RemixclipServeOptions } from './server.js';
import { openDatabase, getDefaultDbPath } from './db.js';
import { resolveDaemonUrl, DEFAULT_DAEMON_URL } from './daemon-url.js';
import { startDaemonIpc } from './sidecar-ipc.js';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';

const cli = cac('remixclip');

// ── daemon subcommand ──────────────────────────────────────────────────────

cli
  .command('[...args]', 'Start the daemon (default command)')
  .option('--port <port>', 'Port to listen on', { default: process.env.OD_PORT ?? '7456' })
  .option('--namespace <name>', 'Runtime namespace', { default: 'default' })
  // Web UI static export dir; defaults to OD_WEB_DIST_DIR, then to the repo-relative path.
  .option('--web-dist <dir>', 'Web UI static export dir (defaults to OD_WEB_DIST_DIR)')
  // Data dir (db/app-config/projects/artifacts); defaults to OD_DATA_DIR, then to repo-relative apps/.remixclip.
  .option('--data-dir <dir>', 'Data dir for db/config/artifacts (defaults to OD_DATA_DIR)')
  // Sidecar stamp flags (passed through argv by tools-dev at startup, declared only to be
  // ignored — cac reports Unknown option and exits for undeclared options)
  .option('--od-stamp-app <app>', 'sidecar stamp (ignored)', { default: '' })
  .option('--od-stamp-ipc <path>', 'sidecar stamp (ignored)', { default: '' })
  .option('--od-stamp-mode <mode>', 'sidecar stamp (ignored)', { default: '' })
  .option('--od-stamp-namespace <ns>', 'sidecar stamp (ignored)', { default: '' })
  .option('--od-stamp-source <src>', 'sidecar stamp (ignored)', { default: '' })
  .action(async (_args: string[], flags: Record<string, unknown>) => {
    const port = Number(flags.port) || 7456;
    const webDistDir =
      (typeof flags.webDist === 'string' && flags.webDist.length > 0 ? flags.webDist : undefined) ??
      process.env[SIDECAR_ENV.WEB_DIST_DIR] ??
      undefined;
    const dataDir =
      (typeof flags.dataDir === 'string' && flags.dataDir.length > 0 ? flags.dataDir : undefined) ??
      process.env[SIDECAR_ENV.DATA_DIR] ??
      undefined;
    const options: RemixclipServeOptions = { port, webDistDir, dataDir };
    try {
      const { server } = await startRemixclipServer(options);
      console.log(`[remixclip] daemon listening on http://127.0.0.1:${port}`);

      // Control channel used by `tools-dev stop` (fast shutdown) and by
      // `resolveDaemonUrl` (real service discovery). Absent when the daemon is
      // started without a sidecar stamp, in which case HTTP keeps working.
      let ipcServer: Awaited<ReturnType<typeof startDaemonIpc>> = null;
      ipcServer = await startDaemonIpc({
        url: `http://127.0.0.1:${port}`,
        onShutdown: () => {
          console.log('[remixclip] shutdown requested over sidecar IPC');
          ipcServer?.close();
          server.close(() => process.exit(0));
          // The HTTP server may have keep-alive sockets; never hang the parent.
          setTimeout(() => process.exit(0), 1500).unref();
        },
      });

      // Keep running
      await new Promise<void>((resolve) => {
        process.on('SIGINT', () => {
          console.log('\n[remixclip] shutting down...');
          ipcServer?.close();
          server.close();
          resolve();
        });
      });
    } catch (error) {
      console.error(`[remixclip] failed to start: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── daemon-url helper ──────────────────────────────────────────────────────

cli
  .command('daemon-url', 'Print the resolved daemon URL')
  .option('--flag-url <url>', 'Explicit URL')
  .action(async (flags: Record<string, unknown>) => {
    const url = await resolveDaemonUrl({
      flagUrl: (flags.flagUrl as string) ?? null,
    });
    console.log(url);
  });

// ── Parse ──────────────────────────────────────────────────────────────────

cli.help();
cli.version('0.1.0');

try {
  cli.parse();
} catch (error) {
  console.error(`[remixclip] error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}