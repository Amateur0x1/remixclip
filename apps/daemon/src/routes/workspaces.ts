/**
 * [INPUT]: conversation private working dir, relative artifact path, real filesystem.
 * [OUTPUT]: read-only artifact file endpoint matching the run's actual dir; HTML served as plain text.
 * [POS]: daemon's artifact access boundary, preventing path escape.
 * Workspace routes — serve artifact file contents from the conversation working dir.
 *
 *   GET /api/workspaces/:conversationId/file?path=<rel>
 *
 * Security constraints (aligned with open-design chat-artifacts' approach):
 * - conversationId allowlist check; after resolve, rel path must stay inside the working dir
 *   (prevents ../ escape); read-only, GET only;
 * - .html is returned as text/plain — the frontend fetches it and previews via a srcdoc
 *   iframe, never letting agent-generated scripts run on the daemon's own origin.
 */

import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment } from '@remixclip/contracts';

const CONV_ID_RE = /^conv_[A-Za-z0-9-]+$/;
const ATT_ID_RE = /^att_[A-Za-z0-9-]+$/;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function sanitizeAttachmentName(raw: string): string {
  const base = path.basename(raw.trim() || 'attachment').replace(/[\u0000-\u001f/\\?%*:|"<>]/g, '_');
  if (!base || base === '.' || base === '..') return 'attachment';
  if (base.length <= 120) return base;
  const ext = path.extname(base).slice(0, 20);
  const stem = path.basename(base, path.extname(base)).slice(0, 120 - ext.length);
  return `${stem}${ext}`;
}

export function resolveAttachmentFile(
  dataDir: string,
  input: unknown,
): { attachment: ChatAttachment; absPath: string } {
  if (!input || typeof input !== 'object') {
    throw new Error('无效的附件格式');
  }
  const candidate = input as Partial<ChatAttachment>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  const rawName = typeof candidate.name === 'string' ? candidate.name : '';
  const name = sanitizeAttachmentName(rawName);
  if (!ATT_ID_RE.test(id) || !name) {
    throw new Error('附件 ID 或文件名非法');
  }
  const attachmentsRoot = path.resolve(dataDir, 'attachments');
  const dir = path.resolve(attachmentsRoot, id);
  const absPath = path.resolve(dir, name);
  if (!dir.startsWith(attachmentsRoot + path.sep) || !absPath.startsWith(dir + path.sep)) {
    throw new Error('附件路径越界');
  }
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    throw new Error(`附件不存在或已过期：${name}`);
  }
  const st = statSync(absPath);
  const mimeType = typeof candidate.mimeType === 'string' && candidate.mimeType.trim()
    ? candidate.mimeType.trim().slice(0, 120)
    : 'application/octet-stream';
  return {
    attachment: {
      id,
      name,
      mimeType,
      size: st.size,
      url: `/api/attachments/${id}/${encodeURIComponent(name)}`,
    },
    absPath,
  };
}

export function registerWorkspaceRoutes(app: Express, dataDir: string, db: Database.Database): void {
  const workspacesRoot = path.resolve(dataDir, 'workspaces');
  const attachmentsRoot = path.resolve(dataDir, 'attachments');

  // ── Upload chat attachments (pasted screenshot / file picker)─────────────
  app.post('/api/attachments', (req: Request, res: Response) => {
    const body = req.body as { name?: unknown; mimeType?: unknown; dataBase64?: unknown } | undefined;
    if (!body || typeof body.dataBase64 !== 'string' || !body.dataBase64.trim()) {
      res.status(400).json({ error: '缺少文件内容 dataBase64' });
      return;
    }
    const rawBase64 = body.dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
    let buffer: Buffer;
    try {
      buffer = Buffer.from(rawBase64, 'base64');
    } catch {
      res.status(400).json({ error: '文件内容 base64 解码失败' });
      return;
    }
    if (buffer.byteLength === 0) {
      res.status(400).json({ error: '不能上传空文件' });
      return;
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({ error: '单个附件不能超过 20 MB' });
      return;
    }
    const id = `att_${randomUUID()}`;
    const name = sanitizeAttachmentName(typeof body.name === 'string' ? body.name : 'attachment');
    const mimeType = typeof body.mimeType === 'string' && body.mimeType.trim()
      ? body.mimeType.trim().slice(0, 120)
      : 'application/octet-stream';
    const dir = path.join(attachmentsRoot, id);
    mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, name);
    writeFileSync(abs, buffer);
    const attachment: ChatAttachment = {
      id,
      name,
      mimeType,
      size: buffer.byteLength,
      url: `/api/attachments/${id}/${encodeURIComponent(name)}`,
    };
    res.json({ attachment });
  });

  // ── Read chat attachments ───────────────────────────────────────────────
  app.get('/api/attachments/:id/:name', (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const rawName = String(req.params.name ?? '');
    if (!ATT_ID_RE.test(id) || !rawName) {
      res.status(400).json({ error: '非法附件参数' });
      return;
    }
    const name = sanitizeAttachmentName(rawName);
    const dir = path.resolve(attachmentsRoot, id);
    const abs = path.resolve(dir, name);
    if (!dir.startsWith(attachmentsRoot + path.sep) || !abs.startsWith(dir + path.sep)) {
      res.status(400).json({ error: '路径越界' });
      return;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.status(404).json({ error: '附件不存在' });
      return;
    }
    // Force plain-text response for HTML / SVG / XML, so no scripts run on the daemon origin
    if (/\.(html?|svg|xml)$/i.test(abs)) {
      res.type('text/plain; charset=utf-8');
    }
    res.sendFile(abs, { dotfiles: 'allow' });
  });

  app.get('/api/workspaces/:conversationId/file', async (req: Request, res: Response) => {
    const conversationId = String(req.params.conversationId ?? '');
    if (!CONV_ID_RE.test(conversationId)) {
      res.status(400).json({ error: '非法 conversationId' });
      return;
    }
    const rel = String(req.query.path ?? '');
    if (!rel || path.isAbsolute(rel)) {
      res.status(400).json({ error: '缺少 path 或路径非法' });
      return;
    }
    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as { id: string } | undefined;
    if (!conversation) return void res.status(404).json({ error: '会话不存在' });
    const base = path.join(workspacesRoot, conversationId);
    const abs = path.resolve(base, rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      res.status(400).json({ error: '路径越界' });
      return;
    }
    if (!existsSync(abs) || !statSync(abs).isFile() ||
        !realpathSync(abs).startsWith(realpathSync(base) + path.sep)) {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    // Force plain text for HTML: for frontend srcdoc preview; direct navigation runs no scripts
    if (/\.html?$/i.test(abs)) {
      res.type('text/plain; charset=utf-8');
    }
    // dotfiles: 'allow' — the data dir itself contains a dot segment (apps/.remixclip) and
    // send's default dotfiles:'ignore' would 404 the whole path; escape guards are already
    // done by the resolve checks above
    res.sendFile(abs, { dotfiles: 'allow' });
  });
}
