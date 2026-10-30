/**
 * [INPUT]: extension import requests, library query params, pairing codes, remote CDN image/video
 *   URLs and local media paths.
 * [OUTPUT]: library REST endpoints, video download/query/delete, remote media proxy with referer and
 *   local media proxy.
 * [POS]: daemon's library HTTP boundary; inputs always pass through the zod schemas in contracts
 *   first, and the media proxy only allows known social-media CDNs and dataDir/media/ (anti-SSRF /
 *   path traversal).
 */
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { LibraryListQuery, LibraryPairingInfo } from '@remixclip/contracts';
import {
  libraryCompareRequestSchema,
  libraryImportRequestSchema,
  libraryListQuerySchema,
  libraryMediaQuerySchema,
  libraryPairRequestSchema,
} from '@remixclip/contracts';
import {
  authenticateDevice,
  clearLibraryItems,
  deleteLibraryItem,
  getLibraryItem,
  importLibraryItems,
  initLibrary,
  isAllowedMediaHost,
  issuePairingCode,
  listDevices,
  listLibraryBatches,
  listLibraryItems,
  mediaReferer,
  openAutoPairWindow,
  pairDevice,
  pairDeviceAuto,
  removeDevice,
} from '../library/store.js';
import { resolveFfmpeg } from '../library/ffmpeg.js';
import {
  deleteMediaFile,
  enqueueVideoDownload,
  findSourceMedia,
  initMediaStorage,
  isInsideMediaRoot,
  listMediaFiles,
  mediaLayout,
  registerLocalMedia,
  safeSegment,
} from '../library/media.js';
import { getShotJob, listShots, startShotAnalysis } from '../library/shots.js';
import { getComparison, listComparisons, startComparison } from '../library/compare.js';

const MAX_IMAGE_CACHE_BYTES = 25 * 1024 * 1024;
/** Upload limit for replica clips: kept consistent with original video downloads. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

function endpointFor(req: Request): string {
  const port = req.socket.localPort ?? 7456;
  return `http://127.0.0.1:${port}`;
}

/** Download priority: primary video URL → first entry in the fallback URL list; http(s) only. */
function pickVideoUrl(item: { videoUrl?: string; videoUrls?: string[] }): string | undefined {
  const candidates = [item.videoUrl, ...(item.videoUrls ?? [])];
  return candidates.find((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
}

function requestToken(req: Request): string {
  const header = req.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return (req.get('x-remixclip-token') ?? '').trim();
}

/**
 * Turn a zod failure message into a one-liner for the frontend/extension.
 * Structured after ZodError.issues; the daemon does not depend on zod directly (schemas are
 * defined only in contracts).
 */
function firstIssueMessage(error: {
  issues: { code: string; path: (string | number)[]; message: string }[];
}, fallback: string): string {
  const issue = error.issues[0];
  if (!issue) return fallback;
  // Top-level type errors (array / primitive) are normalized to one natural-language summary.
  if (issue.code === 'invalid_type' && issue.path.length === 0) return '请求体必须是 JSON 对象';
  // Single-level field errors already carry Chinese messages, show them as-is; only deeper
  // paths need the field name for locating.
  if (issue.path.length <= 1) return issue.message;
  return `${issue.path.join('.')}: ${issue.message}`;
}

function isExtensionOrigin(origin: string): boolean {
  return origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

/** Extension imports must carry a pairing token; same-origin web / local curl imports do not. */
function requireDevice(req: Request, res: Response): boolean {
  const origin = req.get('origin') ?? '';
  if (!isExtensionOrigin(origin)) return true;
  if (authenticateDevice(requestToken(req))) return true;
  res.status(401).json({ error: '未配对：请先在 RemixClip 素材库中获取配对码' });
  return false;
}

export function registerLibraryRoutes(app: Express, dataDir: string, db: Database.Database): void {
  initLibrary(dataDir);
  initMediaStorage(dataDir);
  const cacheDir = path.join(dataDir, 'library-media-cache');
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });

  app.get('/api/library/ping', (_req: Request, res: Response) => {
    res.json({ ok: true, app: 'remixclip' });
  });

  // ── Pairing ─────────────────────────────────────────────────────────────
  app.get('/api/library/pairing', (req: Request, res: Response) => {
    const { code, expiresAt } = issuePairingCode();
    const info: LibraryPairingInfo = {
      endpoint: endpointFor(req),
      code,
      expiresAt,
      devices: listDevices(),
    };
    res.json(info);
  });

// Opened by the app (never by the extension): lets the extension pair without a code for 2 min.
app.post('/api/library/pair-window', (req: Request, res: Response) => {
  if (isExtensionOrigin(req.get('origin') ?? '')) {
    res.status(403).json({ error: '请先在 RemixClip 素材库中开启自动连接' });
    return;
  }
  res.json({ expiresAt: openAutoPairWindow() });
});

app.post('/api/library/pair', (req: Request, res: Response) => {
const parsed = libraryPairRequestSchema.safeParse(req.body ?? {});
if (!parsed.success) {
res.status(400).json({ error: firstIssueMessage(parsed.error, '缺少配对码') });
return;
}
const { code, auto, client } = parsed.data;
if (auto) {
// Auto-pairing is only meaningful from the extension, and only inside the window the
// user just opened in the app; a web page cannot set this Origin header.
if (!isExtensionOrigin(req.get('origin') ?? '')) {
res.status(403).json({ error: '自动连接只能由浏览器插件发起' });
return;
}
const device = pairDeviceAuto(client);
if (!device) {
res.status(400).json({ error: '自动连接未开启或已过期：请在 RemixClip 素材库中点击「连接插件」' });
return;
}
res.json({ token: device.token, device, endpoint: endpointFor(req) });
return;
}
if (!code) {
res.status(400).json({ error: '缺少配对码' });
return;
}
const device = pairDevice(code, client);
if (!device) {
      res.status(400).json({ error: '配对码无效或已过期，请在 RemixClip 中重新获取' });
      return;
    }
    res.json({ token: device.token, device, endpoint: endpointFor(req) });
  });

  app.delete('/api/library/devices/:id', (req: Request, res: Response) => {
    const removed = removeDevice(String(req.params.id ?? ''));
    if (!removed) {
      res.status(404).json({ error: '设备不存在' });
      return;
    }
    res.json({ ok: true });
  });

  // ── Import ──────────────────────────────────────────────────────────────
  app.post('/api/library/import', (req: Request, res: Response) => {
    if (!requireDevice(req, res)) return;
    const parsed = libraryImportRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssueMessage(parsed.error, '导入内容必须是 JSON 对象') });
      return;
    }
    const body = parsed.data;
    const hasItems = ['notes', 'cards', 'users', 'items'].some((key) => {
      const value = body[key as 'notes' | 'cards' | 'users' | 'items'];
      return Array.isArray(value) && value.length > 0;
    });
    if (!hasItems) {
      res.status(400).json({ error: '没有可导入的条目（notes / cards / users / items 均为空）' });
      return;
    }
    const label = body.filename?.trim()
      ? path.basename(body.filename).slice(0, 120)
      : undefined;
    try {
      const result = importLibraryItems(db, body, {
        source: isExtensionOrigin(req.get('origin') ?? '') ? 'extension' : 'file',
        label,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '导入失败' });
    }
  });

  // ── Query / manage ──────────────────────────────────────────────────────
  app.get('/api/library/items', (req: Request, res: Response) => {
    const parsed = libraryListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssueMessage(parsed.error, '查询参数不合法') });
      return;
    }
    // The schema only narrows the value ranges; defaults and domain types are filled in here.
    const query: LibraryListQuery = {
      platform: parsed.data.platform ?? 'all',
      q: parsed.data.q ?? '',
      sort: parsed.data.sort ?? 'imported',
      limit: parsed.data.limit ?? 60,
      offset: parsed.data.offset ?? 0,
    };
    res.json(listLibraryItems(db, query));
  });

  app.get('/api/library/items/:id', (req: Request, res: Response) => {
    const item = getLibraryItem(db, String(req.params.id ?? ''));
    if (!item) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    res.json({ item });
  });

  app.delete('/api/library/items/:id', (req: Request, res: Response) => {
    const removed = deleteLibraryItem(db, String(req.params.id ?? ''));
    if (!removed) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    res.json({ ok: true });
  });

  app.delete('/api/library/items', (_req: Request, res: Response) => {
    const removed = clearLibraryItems(db);
    res.json({ ok: true, removed });
  });

  app.get('/api/library/batches', (_req: Request, res: Response) => {
    res.json({ batches: listLibraryBatches(db) });
  });

  // ── Video landing ───────────────────────────────────────────────────────
  // Social-media video URLs are hotlink-protected and expire; once on disk, shot analysis and
  // comparison only use local files.
  app.post('/api/library/items/:id/download', (req: Request, res: Response) => {
    const item = getLibraryItem(db, String(req.params.id ?? ''));
    if (!item) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    const url = pickVideoUrl(item);
    if (!url) {
      res.status(400).json({ error: '这条素材没有可下载的视频地址' });
      return;
    }
    if (!resolveFfmpeg()) {
      res.status(503).json({ error: 'ffmpeg 不可用' });
      return;
    }
    const media = enqueueVideoDownload(db, item, url);
    res.json({ media });
  });

  app.get('/api/library/items/:id/media', (req: Request, res: Response) => {
    res.json({ media: listMediaFiles(db, String(req.params.id ?? '')) });
  });

  app.delete('/api/library/items/:id/media/:mediaId', (req: Request, res: Response) => {
    const itemId = String(req.params.id ?? '');
    const mediaId = String(req.params.mediaId ?? '');
    const media = listMediaFiles(db, itemId).find((entry) => entry.id === mediaId);
    if (!media) {
      res.status(404).json({ error: '媒体文件不存在' });
      return;
    }
    deleteMediaFile(db, mediaId);
    res.json({ ok: true });
  });

  // ── Shot analysis ───────────────────────────────────────────────────────
  app.post('/api/library/items/:id/analyze', (req: Request, res: Response) => {
    const itemId = String(req.params.id ?? '');
    if (!getLibraryItem(db, itemId)) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    const source = findSourceMedia(db, itemId);
    if (!source) {
      res.status(400).json({ error: '还没有本地原片，请先下载视频' });
      return;
    }
    if (!resolveFfmpeg()) {
      res.status(503).json({ error: 'ffmpeg 不可用' });
      return;
    }
    const job = startShotAnalysis(db, itemId, source.path, source.durationMs);
    res.json({ jobId: job.jobId, status: 'running' });
  });

  app.get('/api/library/items/:id/shots', (req: Request, res: Response) => {
    const itemId = String(req.params.id ?? '');
    res.json({
      shots: listShots(db, itemId),
      media: findSourceMedia(db, itemId),
      job: getShotJob(itemId),
    });
  });

  // ── Pixel verification ──────────────────────────────────────────────────
  // Replica upload: the video stream lands directly in media/renders/, no multipart dependency.
  app.post('/api/library/items/:id/renders', async (req: Request, res: Response) => {
    const itemId = String(req.params.id ?? '');
    if (!getLibraryItem(db, itemId)) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    if ((req.get('content-type') ?? '').includes('application/json')) {
      res.status(415).json({ error: '请以视频流上传复刻片' });
      return;
    }

    const rawName = typeof req.query.filename === 'string' ? req.query.filename : 'render.mp4';
    const parsed = path.parse(path.basename(rawName));
    const dest = path.join(mediaLayout().renders, `${randomUUID()}-${safeSegment(parsed.name)}${parsed.ext || '.mp4'}`);

    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          callback(new Error('复刻片超过 500MB 上限'));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(req, meter, createWriteStream(dest));
    } catch (error) {
      if (existsSync(dest)) rmSync(dest, { force: true });
      res.status(400).json({ error: error instanceof Error ? error.message : '上传复刻片失败' });
      return;
    }
    if (bytes === 0) {
      rmSync(dest, { force: true });
      res.status(400).json({ error: '复刻片内容为空' });
      return;
    }

    const media = registerLocalMedia(db, itemId, dest, 'render');
    res.json({ media });
  });

  app.post('/api/library/items/:id/compare', (req: Request, res: Response) => {
    const itemId = String(req.params.id ?? '');
    if (!getLibraryItem(db, itemId)) {
      res.status(404).json({ error: '素材不存在' });
      return;
    }
    const parsed = libraryCompareRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: firstIssueMessage(parsed.error, '缺少复刻片') });
      return;
    }
    if (!resolveFfmpeg()) {
      res.status(503).json({ error: 'ffmpeg 不可用' });
      return;
    }
    try {
      res.json(startComparison(db, itemId, parsed.data));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : '启动比对失败' });
    }
  });

  app.get('/api/library/items/:id/comparisons', (req: Request, res: Response) => {
    res.json({ comparisons: listComparisons(db, String(req.params.id ?? '')) });
  });

  app.get('/api/library/comparisons/:id', (req: Request, res: Response) => {
    const comparison = getComparison(db, String(req.params.id ?? ''));
    if (!comparison) {
      res.status(404).json({ error: '比对结果不存在' });
      return;
    }
    res.json({ comparison });
  });

  // ── Media proxy ─────────────────────────────────────────────────────────
  // Social-media CDNs generally validate the referer; a direct browser request gets 403. Here
  // the daemon fetches with the referer and caches images; the frontend only hits same-origin
  // /api/library/media.
  app.get('/api/library/media', async (req: Request, res: Response) => {
    const parsed = libraryMediaQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: firstIssueMessage(parsed.error, '缺少媒体地址') });
      return;
    }

    // ── Local files: only allow paths inside dataDir/media/ (shot thumbnails / comparison
    // frames / diff images / local replica clips)
    if (parsed.data.src) {
      const target = path.resolve(parsed.data.src);
      if (!isInsideMediaRoot(target) || !existsSync(target)) {
        res.status(404).json({ error: '本地媒体不存在或不允许访问' });
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.sendFile(target, (error) => {
        if (error && !res.headersSent) res.status(500).end();
      });
      return;
    }

    const raw = parsed.data.url!;
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.status(400).json({ error: '媒体地址非法' });
      return;
    }
    if (!['http:', 'https:'].includes(target.protocol) || !isAllowedMediaHost(target.hostname)) {
      res.status(403).json({ error: '不允许代理该媒体域名' });
      return;
    }

    const range = req.get('range');
    const cacheable = !range;
    const key = createHash('sha256').update(target.toString()).digest('hex');
    const metaPath = path.join(cacheDir, `${key}.json`);
    const binPath = path.join(cacheDir, `${key}.bin`);

    if (cacheable && existsSync(metaPath) && existsSync(binPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { type?: string; size?: number };
        const type = meta.type ?? 'application/octet-stream';
        if ((meta.size ?? 0) <= MAX_IMAGE_CACHE_BYTES) {
          res.setHeader('Content-Type', type);
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          createReadStream(binPath).pipe(res);
          return;
        }
      } catch {
        // Corrupt cache: fall back to fetching from the source again.
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    res.on('close', () => controller.abort());
    try {
      const headers: Record<string, string> = {
        Referer: mediaReferer(target.hostname),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/png,image/*,video/*,*/*;q=0.8',
      };
      if (range) headers.Range = range;
      const upstream = await fetch(target, { headers, redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);

      const finalUrl = new URL(upstream.url || target.toString());
      if (!isAllowedMediaHost(finalUrl.hostname)) {
        res.status(403).json({ error: '媒体重定向到不允许的域名' });
        return;
      }
      if (!upstream.ok && upstream.status !== 206) {
        res.status(upstream.status === 403 ? 403 : 502).json({ error: `媒体源返回 ${upstream.status}` });
        return;
      }

      const type = upstream.headers.get('content-type') ?? 'application/octet-stream';
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', cacheable ? 'public, max-age=31536000, immutable' : 'no-store');
      const length = upstream.headers.get('content-length');
      if (length) res.setHeader('Content-Length', length);
      const contentRange = upstream.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);
      const acceptRanges = upstream.headers.get('accept-ranges');
      if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
      if (upstream.status === 206) res.status(206);

      if (!upstream.body) {
        res.status(502).json({ error: '媒体源没有返回内容' });
        return;
      }

      // Only images are cached to disk; video size is unpredictable, so stream it through.
      if (cacheable && type.startsWith('image/') && Number(length ?? 0) <= MAX_IMAGE_CACHE_BYTES) {
        const buffer = Buffer.from(await upstream.arrayBuffer());
        writeFileSync(binPath, buffer);
        writeFileSync(metaPath, JSON.stringify({ type, size: buffer.byteLength }), 'utf8');
        res.end(buffer);
        return;
      }

      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (error) {
      clearTimeout(timeout);
      if (!res.headersSent) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        res.status(aborted ? 504 : 502).json({ error: aborted ? '媒体源超时' : '媒体拉取失败' });
      } else {
        res.end();
      }
    }
  });
}
