/**
 * [INPUT]: daemon address, optional REMIXCLIP_WEB_DEV_URL, desktop logo and packaged resource paths.
 * [OUTPUT]: Native window with the RemixClip icon; dev loads the Next hot-reload page, packaged loads the daemon's static page.
 * [POS]: Desktop main-process entry, owning the window and the daemon lifecycle when packaged.
 */
import { app, BrowserWindow, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// ── Minimal shell ──────────────────────────────────────────────────────────
// open-design approach: desktop is just a shell. In dev the daemon is started separately by
// tools-dev as a sidecar; Electron loads the Next dev server by default to support HMR,
// REMIXCLIP_WEB_DEV_URL can override the address; packaged still has the daemon serve the static Web UI.
//
// Packaged builds (dmg / installer) have no tools-dev, so when app.isPackaged the shell spawns
// the bundled daemon itself (see startDaemon). Dev behavior is completely unchanged.

const RESOURCES_PATH: string | undefined = (process as unknown as { resourcesPath?: string })
  .resourcesPath;

const daemonPort = parseInt(
  process.env.OD_PORT || process.env.REMIXCLIP_DAEMON_PORT || '7456',
  10,
);
const daemonUrl = `http://127.0.0.1:${daemonPort}`;
const devWebUrl = process.env.REMIXCLIP_WEB_DEV_URL || 'http://127.0.0.1:7457';
const targetUrl = app.isPackaged ? daemonUrl : devWebUrl;

let daemonChild: ChildProcess | null = null;

// In dev the icon is read from the source repo; when packaged the same PNG comes from the resources dir.
const desktopIcon = firstExisting([
  RESOURCES_PATH ? path.join(RESOURCES_PATH, 'remixclip.png') : undefined,
  path.resolve(app.getAppPath(), '..', '..', 'assets', 'remixclip.png'),
]);

async function waitForDaemon(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${daemonUrl}/api/`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // daemon not ready yet, keep polling
    }
    if (Date.now() > deadline) {
      console.warn(`[remixclip-desktop] daemon not ready after ${timeoutMs}ms, loading anyway`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function loadWindow(win: BrowserWindow): Promise<void> {
  while (!win.isDestroyed()) {
    try {
      await win.loadURL(targetUrl);
      return;
    } catch (error) {
      console.warn('[remixclip-desktop] page load failed; retrying:', error);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

// macOS traffic lights aligned with the sidebar grid:
// - horizontal x = 16: AppKit NSWindowButton is 14px wide (holds a 12px dot, left edge x = 17px),
//   strictly left-aligned with the sidebar icon column (px-2 + px-2.5 ≈ 16px) and the workspace main area's left edge (px-[17px]);
// - vertical y = 15: AppKit NSWindowButton is 16px tall (12px dot at y = 17..29px, centerline y = 23px),
//   matching the 46px-tall macOS top bar (centerline y = 23px), so it shares the y = 23px horizontal centerline with the open/collapse sidebar and main-header buttons.
const MAC_TRAFFIC_LIGHTS = { x: 16, y: 15 } as const;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'RemixClip',
    ...(desktopIcon ? { icon: desktopIcon } : {}),
    // macOS hides the native title area and keeps only the window controls; the page provides its own drag regions.
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: MAC_TRAFFIC_LIGHTS } : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const placeTrafficLights = () => {
    if (process.platform !== 'darwin' || win.isDestroyed()) return;
    win.setWindowButtonPosition({ x: MAC_TRAFFIC_LIGHTS.x, y: MAC_TRAFFIC_LIGHTS.y });
  };
  win.once('ready-to-show', placeTrafficLights);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('did-finish-load', () => {
    if (process.platform === 'darwin') {
      void win.webContents.executeJavaScript("document.body.classList.add('remixclip-electron-macos')");
      placeTrafficLights();
    }
    console.log(`[remixclip-desktop] page loaded: ${win.webContents.getURL()}`);
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[remixclip-desktop] renderer exited: ${details.reason}`);
  });

  win.on('closed', () => {
    app.quit();
  });

  return win;
}

// ── Packaged bootstrap ─────────────────────────────────────────────────────
// When packaged the shell spawns the daemon and injects the web output dir and data dir, so the
// daemon doesn't depend on the repo's relative layout. The packaging config must place the
// following resources at the agreed locations (overridable via the same-named env vars):
//   resources/daemon/dist/cli.js   ← @remixclip/daemon build output
//   resources/web-out/index.html   ← apps/web static export
//   resources/node/bin/node        ← standalone Node runtime with the same ABI as better-sqlite3
function firstExisting(candidates: Array<string | undefined>): string | undefined {
  return candidates.find((c): c is string => typeof c === 'string' && existsSync(c));
}

function resolveDaemonEntry(): string | undefined {
  return firstExisting([
    process.env.OD_DAEMON_CLI_PATH,
    RESOURCES_PATH ? path.join(RESOURCES_PATH, 'daemon', 'dist', 'cli.js') : undefined,
    RESOURCES_PATH ? path.join(RESOURCES_PATH, 'daemon', 'cli.js') : undefined,
  ]);
}

function resolveWebDistDir(): string | undefined {
  return firstExisting([
    process.env.OD_WEB_DIST_DIR,
    RESOURCES_PATH ? path.join(RESOURCES_PATH, 'web-out') : undefined,
  ]);
}

function resolveNodeRuntime(): string {
  // Prefer the bundled standalone Node runtime (keeps ABI in sync with better-sqlite3),
  // otherwise fall back to Electron's own Node (ELECTRON_RUN_AS_NODE).
  const bundled = firstExisting([
    RESOURCES_PATH ? path.join(RESOURCES_PATH, 'node', 'bin', 'node') : undefined,
    RESOURCES_PATH ? path.join(RESOURCES_PATH, 'node', 'node') : undefined,
  ]);
  return bundled ?? process.execPath;
}

function startDaemon(): void {
  const entry = resolveDaemonEntry();
  if (!entry) {
    console.warn(
      '[remixclip-desktop] daemon entry not found; set OD_DAEMON_CLI_PATH or ship resources/daemon/dist/cli.js',
    );
    return;
  }

  const nodeRuntime = resolveNodeRuntime();
  const env: Record<string, string | undefined> = {
    ...process.env,
    OD_PORT: String(daemonPort),
    // The data dir must live in a user-writable location (userData), not the app's read-only resources dir.
    OD_DATA_DIR: process.env.OD_DATA_DIR || app.getPath('userData'),
  };
  const webDistDir = resolveWebDistDir();
  if (webDistDir) env.OD_WEB_DIST_DIR = webDistDir;
  // Must be declared explicitly when using Electron itself as Node, otherwise it tries to start a GUI.
  if (nodeRuntime === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

  console.log(`[remixclip-desktop] spawning daemon: ${nodeRuntime} ${entry}`);
  daemonChild = spawn(nodeRuntime, [entry, '--port', String(daemonPort)], {
    env,
    stdio: 'inherit',
  });
  daemonChild.on('exit', (code) => {
    console.log(`[remixclip-desktop] daemon exited with code ${code}`);
  });
}

function shouldSelfSpawnDaemon(): boolean {
  // Self-bootstrap when packaged; in dev set REMIXCLIP_SELF_SPAWN_DAEMON=1 to enable it and verify that path alone.
  return app.isPackaged || process.env.REMIXCLIP_SELF_SPAWN_DAEMON === '1';
}

async function main(): Promise<void> {
  console.log(`[remixclip-desktop] shell loading ${targetUrl}`);

  await app.whenReady();
  if (process.platform === 'darwin' && desktopIcon) app.dock?.setIcon(desktopIcon);
  if (shouldSelfSpawnDaemon()) startDaemon();

  const win = createWindow();

  await waitForDaemon();
  void loadWindow(win);
  app.focus({ steal: true });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void loadWindow(createWindow());
    }
  });
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // Kill the daemon this shell spawned on exit (daemonChild is null in dev, leaving tools-dev's hosting untouched).
  if (daemonChild && !daemonChild.killed) daemonChild.kill();
  app.quit();
});

main().catch((error) => {
  console.error('[remixclip-desktop] fatal:', error);
  process.exit(1);
});
