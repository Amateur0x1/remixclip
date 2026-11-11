/**
 * [INPUT]: the daemon's own bound socket and the external URLs the app asks to open.
 * [OUTPUT]: /api/system/info (bound port + endpoint) and /api/open-external (system browser).
 * [POS]: daemon's system integration routes (host capability, unrelated to the chat domain).
 */
import type { DaemonRuntimeInfo } from '@remixclip/contracts';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';
import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';
import { listWebOrigins } from '../web-origins.js';

/** Only allow http(s), so arbitrary schemes never reach the system opener. */
function openWithSystem(url: string): void {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

export function registerSystemRoutes(app: Express): void {
  // The port the listener actually bound, not a declared constant: the settings drawer and the
  // browser extension both read this so a custom or dynamically allocated port is never guessed.
  app.get('/api/system/info', (req: Request, res: Response) => {
    const port = req.socket.localPort ?? null;
    const info: DaemonRuntimeInfo = {
      pid: process.pid,
      port,
      endpoint: port == null ? null : `http://${req.hostname || '127.0.0.1'}:${port}`,
      webOrigin: listWebOrigins()[0] ?? process.env[SIDECAR_ENV.WEB_ORIGIN] ?? null,
    };
    res.json(info);
  });

  app.post('/api/open-external', (req: Request, res: Response) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      res.status(400).json({ error: '链接格式非法' });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.status(400).json({ error: '只支持 http/https 链接' });
      return;
    }
    try {
      openWithSystem(parsed.toString());
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '打开链接失败' });
    }
  });
}
