const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');

const distDir = __dirname;
const repoRoot = path.resolve(distDir, '..', '..', '..', '..');

async function main() {
  const daemonPort = process.env.REMIXCLIP_DAEMON_PORT
    ? parseInt(process.env.REMIXCLIP_DAEMON_PORT, 10)
    : 7456;

  console.log(`[remixclip-desktop] starting on http://127.0.0.1:${daemonPort}`);

  // Start daemon as child process
  const daemonChild = spawn('node', [
    path.join(repoRoot, 'apps', 'daemon', 'dist', 'cli.js'),
    '--port', String(daemonPort),
  ], {
    stdio: 'inherit',
    env: { ...process.env, REMIXCLIP_DAEMON_PORT: String(daemonPort) },
  });

  daemonChild.on('exit', (code) => {
    console.log(`[remixclip-desktop] daemon exited with code ${code}`);
    app.quit();
  });

  await app.whenReady();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'RemixClip — 市场研究助手',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(`http://127.0.0.1:${daemonPort}`);

  win.on('closed', () => app.quit());

  app.on('window-all-closed', () => {
    daemonChild.kill();
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWin = new BrowserWindow({ width: 1280, height: 860, title: 'RemixClip' });
      newWin.loadURL(`http://127.0.0.1:${daemonPort}`);
    }
  });
}

main().catch((error) => {
  console.error('[remixclip-desktop] fatal:', error);
  process.exit(1);
});