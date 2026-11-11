/**
 * [INPUT]: the conversation's project working dir, a relative artifact path, the real filesystem.
 * [OUTPUT]: read-only file endpoint and one-level directory tree endpoint matching the run's
 *           actual cwd; HTML served as plain text.
 * [POS]: daemon's artifact access boundary, preventing path escape.
 * Workspace routes — serve artifact files and folders from the conversation's project dir.
 *
 *   GET /api/workspaces/:conversationId/file?path=<rel>
 *   GET /api/workspaces/:conversationId/tree?path=<rel dir>
 *
 * Security constraints (aligned with open-design chat-artifacts' approach):
 * - conversationId allowlist check; after resolve, rel path must stay inside the working dir
 *   (prevents ../ escape); read-only, GET only;
 * - .html is returned as text/plain — the frontend fetches it and previews via a srcdoc
 *   iframe, never letting agent-generated scripts run on the daemon's own origin;
 * - symlinks are never listed and every read re-checks the real path, so a link cannot walk out.
 */

import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatAttachment, WorkspaceEntry, WorkspaceTreeResponse } from '@remixclip/contracts';
import { workspaceFileKind } from '@remixclip/contracts';
import { getConversationProjectId } from '../db.js';
import { projectWorkspaceDir } from '../project-workspace.js';

const CONV_ID_RE = /^conv_[A-Za-z0-9-]+$/;
const ATT_ID_RE = /^att_[A-Za-z0-9-]+$/;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** A single directory never returns more rows than this; the panel only needs the first screen. */
const MAX_TREE_ENTRIES = 500;
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.next',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
]);
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db']);

/** Only the formats a browser can actually render/stream get a concrete type; the rest is binary. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

function mimeForName(name: string): string {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** The conversation's working dir: its project dir, with the legacy per-conversation dir as fallback. */
function conversationWorkspaceDir(
  dataDir: string,
  db: Database.Database,
  conversationId: string,
): string {
  const projectId = getConversationProjectId(db, conversationId);
  return projectId
    ? projectWorkspaceDir(dataDir, projectId)
    : path.resolve(dataDir, 'workspaces', conversationId);
}

/** Resolve `<base>/<rel>`, refusing absolute input and any path that escapes the base. */
function resolveInside(base: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel)) return null;
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function listDirectory(target: string, relDir: string): WorkspaceTreeResponse {
  const entries: WorkspaceEntry[] = [];
  let truncated = false;
  for (const dirent of readdirSync(target, { withFileTypes: true })) {
    if (dirent.name.startsWith('.')) continue;
    if (IGNORED_FILE_NAMES.has(dirent.name)) continue;
    if (dirent.isDirectory() && IGNORED_DIR_NAMES.has(dirent.name)) continue;
    // Symlinks are skipped on purpose: the listing must only describe bytes inside the project.
    if (!dirent.isDirectory() && !dirent.isFile()) continue;
    if (entries.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      break;
    }
    const abs = path.join(target, dirent.name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    const childRel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: childRel, type: 'dir', size: 0, mtimeMs: stat.mtimeMs });
    } else {
      entries.push({
        name: dirent.name,
        path: childRel,
        type: 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        kind: workspaceFileKind(dirent.name),
        mime: mimeForName(dirent.name),
      });
    }
  }
  // Folders first, then names — the same order a desktop file browser uses.
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
  );
  return { path: relDir, entries, truncated };
}

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
    const base = conversationWorkspaceDir(dataDir, db, conversationId);
    const abs = resolveInside(base, rel);
    if (!abs) {
      res.status(400).json({ error: '路径越界' });
      return;
    }
    if (!existsSync(base) || !existsSync(abs) || !statSync(abs).isFile() ||
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

  // ── Browse the project working dir (artifact panel) ─────────────────────
  app.get('/api/workspaces/:conversationId/tree', (req: Request, res: Response) => {
    const conversationId = String(req.params.conversationId ?? '');
    if (!CONV_ID_RE.test(conversationId)) {
      res.status(400).json({ error: '非法 conversationId' });
      return;
    }
    const conversation = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId) as { id: string } | undefined;
    if (!conversation) return void res.status(404).json({ error: '会话不存在' });

    const base = conversationWorkspaceDir(dataDir, db, conversationId);
    // An untouched project has no directory yet: an empty root is the honest answer, not a 404
    // that the panel would paint as a broken folder.
    if (!existsSync(base)) {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ path: '', entries: [], truncated: false } satisfies WorkspaceTreeResponse);
      return;
    }

    const rel = String(req.query.path ?? '').trim();
    const abs = rel ? resolveInside(base, rel) : base;
    if (!abs) {
      res.status(400).json({ error: '路径越界' });
      return;
    }
    const realBase = realpathSync(base);
    const realTarget = existsSync(abs) ? realpathSync(abs) : null;
    const inside = realTarget === realBase || Boolean(realTarget?.startsWith(realBase + path.sep));
    if (!realTarget || !statSync(abs).isDirectory() || !inside) {
      res.status(404).json({ error: '目录不存在' });
      return;
    }
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(listDirectory(abs, rel.replace(/\\/g, '/')));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '目录读取失败' });
    }
  });
}
