/**
 * [INPUT]: Direct video links of items, the dataDir layout, ffprobe and a SQLite connection.
 * [OUTPUT]: media_files rows (pending / downloading / ready / failed), on-disk file paths,
 *   download progress and deletion.
 * [POS]: Library "video landing" domain layer; the parallel queue, retries and .part atomic
 *   replace all live here, while the HTTP layer only triggers and queries.
 */
import type Database from 'better-sqlite3';
import { createWriteStream, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { LibraryItem, MediaFile, MediaFileKind, MediaFileStatus } from '@remixclip/contracts';
import { probeVideo } from './ffmpeg.js';
import { isAllowedMediaHost, mediaReferer } from './store.js';

export interface MediaLayout {
  /** <dataDir>/media, the sole allowlist root for the local media proxy. */
  root: string;
  videos: string;
  frames: string;
  renders: string;
  diffs: string;
}

const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 2;
const RETRY_DELAY_MS = 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

let layout: MediaLayout | null = null;

/**
 * Build the directory layout once; called at daemon startup, later modules fetch it
 * via mediaLayout().
 */
export function initMediaStorage(dataDir: string): MediaLayout {
  const root = path.join(path.resolve(dataDir), 'media');
  const next: MediaLayout = {
    root,
    videos: path.join(root, 'videos'),
    frames: path.join(root, 'frames'),
    renders: path.join(root, 'renders'),
    diffs: path.join(root, 'diffs'),
  };
  for (const dir of [next.root, next.videos, next.frames, next.renders, next.diffs]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  layout = next;
  return next;
}

export function mediaLayout(): MediaLayout {
  if (!layout) throw new Error('媒体目录尚未初始化');
  return layout;
}

/**
 * Reduce any string to a safe filename segment: a library item id looks like `xhs:abc`,
 * and on macOS Finder treats the colon in a filename as a path separator, so it must be
 * replaced.
 */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'item';
}

/**
 * Allowlist check for the local media proxy: only let through files that really exist
 * under the media root (realpath prevents symlink escapes).
 */
export function isInsideMediaRoot(target: string): boolean {
  const { root } = mediaLayout();
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return false;
  }
  const base = realpathSync(root);
  return real === base || real.startsWith(`${base}${path.sep}`);
}

// ── Record read / write ─────────────────────────────────────────────────────

interface MediaRow {
  id: string;
  item_id: string;
  kind: string;
  path: string;
  bytes: number | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  status: string;
  progress: number;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToMediaFile(row: MediaRow): MediaFile {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind as MediaFileKind,
    path: row.path,
    bytes: row.bytes ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    fps: row.fps ?? undefined,
    status: row.status as MediaFileStatus,
    progress: row.progress,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMediaFiles(db: Database.Database, itemId: string): MediaFile[] {
  const rows = db.prepare(
    'SELECT * FROM media_files WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as MediaRow[];
  return rows.map(rowToMediaFile);
}

export function getMediaFile(db: Database.Database, id: string): MediaFile | null {
  const row = db.prepare('SELECT * FROM media_files WHERE id = ?').get(id) as MediaRow | undefined;
  return row ? rowToMediaFile(row) : null;
}

/**
 * The item's currently usable source video (ready and file still present); shot analysis /
 * comparison use it as the baseline.
 */
export function findSourceMedia(db: Database.Database, itemId: string): MediaFile | null {
  const rows = db.prepare(
    `SELECT * FROM media_files
     WHERE item_id = ? AND kind = 'source'
     ORDER BY created_at DESC`,
  ).all(itemId) as MediaRow[];
  for (const row of rows) {
    const media = rowToMediaFile(row);
    if (media.status === 'ready' && existsSync(media.path)) return media;
  }
  return null;
}

/**
 * The item's downloading / ready source video, so repeated 'download' clicks do not
 * create multiple rows.
 */
function findActiveSource(db: Database.Database, itemId: string): MediaFile | null {
  const row = db.prepare(
    `SELECT * FROM media_files
     WHERE item_id = ? AND kind = 'source' AND status IN ('pending', 'downloading', 'ready')
     ORDER BY created_at DESC LIMIT 1`,
  ).get(itemId) as MediaRow | undefined;
  if (!row) return null;
  const media = rowToMediaFile(row);
  // Treat ready-but-manually-deleted as invalid and allow downloading again.
  if (media.status === 'ready' && !existsSync(media.path)) return null;
  return media;
}

function insertMediaRow(
  db: Database.Database,
  input: {
    itemId: string;
    kind: MediaFileKind;
    filePath: string;
    status: MediaFileStatus;
    progress?: number;
    bytes?: number;
    error?: string;
  },
): MediaFile {
  const now = Date.now();
  const id = `media_${randomUUID()}`;
  db.prepare(
    `INSERT INTO media_files
      (id, item_id, kind, path, bytes, duration_ms, width, height, fps, status, progress, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.itemId,
    input.kind,
    input.filePath,
    input.bytes ?? null,
    input.status,
    input.progress ?? 0,
    input.error ?? null,
    now,
    now,
  );
  const created = getMediaFile(db, id);
  if (!created) throw new Error('写入媒体记录失败');
  return created;
}

function patchMedia(
  db: Database.Database,
  id: string,
  patch: Partial<{
    status: MediaFileStatus;
    progress: number;
    bytes: number | null;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    fps: number | null;
    error: string | null;
    path: string;
  }>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];
  const map: Record<string, string> = {
    status: 'status',
    progress: 'progress',
    bytes: 'bytes',
    durationMs: 'duration_ms',
    width: 'width',
    height: 'height',
    fps: 'fps',
    error: 'error',
    path: 'path',
  };
  for (const [key, column] of Object.entries(map)) {
    if (key in patch) {
      sets.push(`${column} = ?`);
      params.push((patch as Record<string, unknown>)[key]);
    }
  }
  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  db.prepare(`UPDATE media_files SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/** Delete the row and files (including leftover .part); returns whether a row was hit. */
export function deleteMediaFile(db: Database.Database, id: string): boolean {
  const media = getMediaFile(db, id);
  if (!media) return false;
  // A render may be a product the agent wrote to any directory, so deleting the row
  // must not delete user files.
  for (const target of [media.path, `${media.path}.part`]) {
    try {
      if (existsSync(target) && isInsideMediaRoot(target)) rmSync(target, { force: true });
    } catch {
      // Still delete the row if the file is locked; the frontend need not retry for that.
    }
  }
  db.prepare('DELETE FROM media_files WHERE id = ?').run(id);
  return true;
}

// ── Download queue ──────────────────────────────────────────────────────────

interface DownloadTask {
  /** Background tasks run outside the request scope, so the db handle travels with the task. */
  db: Database.Database;
  mediaId: string;
  url: string;
  dest: string;
}

const queue: DownloadTask[] = [];
let running = 0;

function pump(): void {
  while (running < MAX_PARALLEL_DOWNLOADS && queue.length > 0) {
    const task = queue.shift()!;
    running += 1;
    void runDownloadTask(task)
      .catch(() => {
        // The failure was already persisted inside the task; here we only keep the queue going.
      })
      .finally(() => {
        running -= 1;
        pump();
      });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single download: write <name>.mp4.part first, rename only after it is fully written,
 * so a half-written file is never treated as ready and handed to ffmpeg.
 */
async function downloadOnce(task: DownloadTask, onProgress: (ratio: number) => void): Promise<number> {
  const target = new URL(task.url);
  if (!isAllowedMediaHost(target.hostname)) throw new Error('不支持的视频域名');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const partPath = `${task.dest}.part`;
  try {
    const response = await fetch(target, {
      headers: {
        Referer: mediaReferer(target.hostname),
        'User-Agent': USER_AGENT,
        Accept: 'video/mp4,video/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`视频源返回 ${response.status}`);
    if (!response.body) throw new Error('视频源没有返回内容');

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) throw new Error('视频超过 500MB 上限，已放弃下载');

    let received = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          callback(new Error('视频超过 500MB 上限，已放弃下载'));
          return;
        }
        onProgress(declared > 0 ? Math.min(received / declared, 0.99) : 0);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      meter,
      createWriteStream(partPath),
    );
    renameSync(partPath, task.dest);
    return received;
  } catch (error) {
    rmSync(partPath, { force: true });
    if (error instanceof Error && error.name === 'AbortError') throw new Error('下载超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function runDownloadTask(task: DownloadTask): Promise<void> {
  const { db } = task;
  let lastPercent = -1;
  const onProgress = (ratio: number) => {
    const percent = Math.floor(ratio * 100);
    if (percent === lastPercent) return;
    lastPercent = percent;
    patchMedia(db, task.mediaId, { status: 'downloading', progress: ratio });
  };

  patchMedia(db, task.mediaId, { status: 'downloading', progress: 0, error: null });
  let bytes = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      bytes = await downloadOnce(task, onProgress);
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : '下载失败';
      if (attempt === 0) {
        // Retry only once: that gets the most out of network jitter / occasional CDN 403s,
        // and more retries just delay failure further.
        await delay(RETRY_DELAY_MS);
        patchMedia(db, task.mediaId, { status: 'downloading', progress: 0, error: message });
        continue;
      }
      patchMedia(db, task.mediaId, { status: 'failed', progress: 0, error: message });
      return;
    }
  }

  const stat = existsSync(task.dest) ? statSync(task.dest) : null;
  patchMedia(db, task.mediaId, { status: 'ready', progress: 1, bytes: stat?.size ?? bytes, error: null });
  try {
    const meta = await probeVideo(task.dest);
    patchMedia(db, task.mediaId, {
      durationMs: meta.durationMs ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      fps: meta.fps ?? null,
    });
  } catch (error) {
    // A probe failure does not affect the file on disk: keep ready, leave metadata empty
    // and let the frontend degrade.
    console.warn(`[remixclip] ffprobe 探测失败 ${task.dest}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Trigger a source download: reuse an existing pending/downloading/ready row,
 * otherwise persist a pending row and enqueue it (parallel cap 2).
 */
export function enqueueVideoDownload(
  db: Database.Database,
  item: LibraryItem,
  url: string,
): MediaFile {
  const existing = findActiveSource(db, item.id);
  if (existing) {
    // Row exists but the queue is lost (daemon restart): enqueue again so it does not
    // stay downloading forever.
    if (existing.status !== 'ready' && !queue.some((task) => task.mediaId === existing.id)) {
      queue.push({ db, mediaId: existing.id, url, dest: existing.path });
      pump();
    }
    return existing;
  }

  const { videos } = mediaLayout();
  const dest = path.join(videos, `${item.platform}-${safeSegment(item.remoteId)}.mp4`);
  // A failed row from a previous round is worthless; drop it on re-download so the detail
  // view has no duplicate sources.
  db.prepare(`DELETE FROM media_files WHERE item_id = ? AND kind = 'source' AND status = 'failed'`).run(item.id);
  const media = insertMediaRow(db, { itemId: item.id, kind: 'source', filePath: dest, status: 'pending' });
  queue.push({ db, mediaId: media.id, url, dest });
  pump();
  return media;
}

/**
 * Register an already written local video (agent render / render uploaded by the frontend).
 * Metadata is probed in the background; a probe failure does not affect the comparison
 * entry itself.
 */
export function registerLocalMedia(
  db: Database.Database,
  itemId: string,
  filePath: string,
  kind: MediaFileKind = 'render',
): MediaFile {
  const absolute = path.resolve(filePath);
  const existing = listMediaFiles(db, itemId).find(
    (entry) => entry.kind === kind && entry.path === absolute && entry.status === 'ready',
  );
  if (existing) return existing;

  const media = insertMediaRow(db, {
    itemId,
    kind,
    filePath: absolute,
    status: 'ready',
    progress: 1,
    bytes: existsSync(absolute) ? statSync(absolute).size : undefined,
  });
  void probeVideo(absolute)
    .then((meta) => {
      patchMedia(db, media.id, {
        durationMs: meta.durationMs ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
        fps: meta.fps ?? null,
      });
    })
    .catch(() => {
      // Metadata is only for display; it is re-probed during comparison.
    });
  return media;
}
