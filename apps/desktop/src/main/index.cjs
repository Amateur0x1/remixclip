const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const daemonPort = process.env.REMIXCLIP_DAEMON_PORT
  ? parseInt(process.env.REMIXCLIP_DAEMON_PORT, 10)
  : 7456;

console.log(`[remixclip-desktop] starting on http://127.0.0.1:${daemonPort}`);

// Start daemon as child process
const daemonChild = spawn('node', [
  path.join(REPO_ROOT, 'apps', 'daemon', 'dist', 'cli.js'),
  '--port', String(daemonPort),
], {
  stdio: 'inherit',
  env: { ...process.env, REMIXCLIP_DAEMON_PORT: String(daemonPort) },
});

daemonChild.on('exit', (code) => {
  console.log(`[remixclip-desktop] daemon exited with code ${code}`);
  process.exit(code ?? 0);
});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'RemixClip — 市场研究助手',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const daemonUrl = `http://127.0.0.1:${daemonPort}`;
  win.loadURL(daemonUrl);

  win.on('closed', () => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  daemonChild.kill();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const win = new BrowserWindow({ width: 1280, height: 860, title: 'RemixClip' });
    win.loadURL(`http://127.0.0.1:${daemonPort}`);
  }
});