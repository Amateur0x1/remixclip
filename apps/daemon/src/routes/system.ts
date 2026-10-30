/**
 * [INPUT]: external link in the HTTP request.
 * [OUTPUT]: /api/open-external endpoint that hands it to the system default browser.
 * [POS]: daemon's system integration routes (host capability, unrelated to the chat domain).
 */
import type { Express, Request, Response } from 'express';
import { spawn } from 'node:child_process';

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
