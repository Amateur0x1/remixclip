/**
* [INPUT]: JSON exported by the browser extension (notes / cards / users / comments) and
*   local SQLite.
* [OUTPUT]: Normalized library items, import batches, list queries and extension presence.
* [POS]: daemon library domain layer; routes only adapt HTTP, dedup/merge/search all converge here.
*/
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  LibraryBatch,
  LibraryComment,
  LibraryCompanion,
  LibraryCounts,
  LibraryImportRequest,
  LibraryImportResult,
  LibraryItem,
  LibraryItemSummary,
  LibraryListQuery,
  LibraryListResponse,
  SocialPlatform,
} from '@remixclip/contracts';
import { buildSocialLink, normalizeSocialPlatform, parseSocialLink } from '@remixclip/contracts';

type UnknownRecord = Record<string, unknown>;

const MAX_IMAGES = 40;
const MAX_COMMENTS = 800;
/** Heartbeats are cheap and frequent; this only bounds how long a closed panel is remembered. */
const COMPANION_TTL_MS = 10 * 60 * 1000;
const MAX_COMPANIONS = 8;

/** The extension has no token: an in-memory heartbeat is the whole handshake. */
let companions: LibraryCompanion[] = [];

export function initLibrary(dataDir: string): void {
const root = path.resolve(dataDir);
if (!existsSync(root)) mkdirSync(root, { recursive: true });
}

// ── Companion presence ──────────────────────────────────────────────────────
// Deliberately memory-only: a daemon restart should forget stale side panels instead of showing a
// connection that no longer exists.

export function greetCompanion(client?: string): void {
const name = client?.trim().slice(0, 80) || 'RemixClip 素材助手';
const now = Date.now();
companions = [
{ name, lastSeenAt: now },
...companions.filter((item) => item.name !== name),
].slice(0, MAX_COMPANIONS);
}

export function listCompanions(): LibraryCompanion[] {
const now = Date.now();
return companions.filter((item) => now - item.lastSeenAt < COMPANION_TTL_MS);
}

// ── Normalization ───────────────────────────────────────────────────────────

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function int(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function timestamp(value: unknown): number | undefined {
  // Pinterest exports ISO-8601 dates; everything else is epoch seconds or milliseconds.
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = int(value);
  if (n <= 0) return undefined;
  // Bilibili/Douyin APIs use seconds, Xiaohongshu uses milliseconds; values below
  // 1e12 are treated as seconds.
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function absoluteUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  if (raw.startsWith('//')) return `https:${raw}`;
  if (!/^https?:\/\//i.test(raw)) return undefined;
  return raw;
}

function inferPlatform(input: LibraryImportRequest, notes: unknown[]): SocialPlatform | null {
  const explicit = normalizeSocialPlatform(input.platform);
  if (explicit) return explicit;
  for (const note of notes) {
    const record = asRecord(note);
    // A post link is enough to know the platform: the contracts schema owns every platform's URL
    // shape, so link-only exports (share sheet, clipboard) no longer need a filename hint.
    const platform = normalizeSocialPlatform(record?.platform)
      ?? parseSocialLink(text(record?.page_url))?.platform;
    if (platform) return platform;
  }
  const filename = (input.filename ?? '').toLowerCase();
  if (filename.includes('xiaohongshu') || filename.startsWith('xhs')) return 'xhs';
  if (filename.includes('bilibili') || filename.startsWith('bili')) return 'bilibili';
  if (filename.includes('douyin') || filename.startsWith('dy')) return 'douyin';
  if (filename.includes('pinterest') || filename.startsWith('pin')) return 'pinterest';
  return null;
}

const VIDEO_FRAME_HOST: Record<SocialPlatform, string> = {
  xhs: 'https://sns-img-bd.xhscdn.com/',
  bilibili: 'https://i0.hdslb.com/',
  douyin: 'https://p3-sign.douyinpic.com/',
  pinterest: 'https://i.pinimg.com/',
};

function normalizeImages(note: UnknownRecord, platform: SocialPlatform): string[] {
  const images = asArray(note.images)
    .map((item) => absoluteUrl(item))
    .filter((url): url is string => Boolean(url));
  const video = asRecord(note.video);
  // The extension sends snake_case, but older captures and the DOM fallback use camelCase.
  const posterRaw = text(video?.first_frame_fileid) || text(video?.firstFrameFileid);
  if (posterRaw) {
    const poster = absoluteUrl(posterRaw)
      ?? (posterRaw.includes('/') || posterRaw.length > 80
        ? undefined
        : `${VIDEO_FRAME_HOST[platform]}${posterRaw}`);
    if (poster && !images.includes(poster)) images.unshift(poster);
  }
  return Array.from(new Set(images)).slice(0, MAX_IMAGES);
}

function normalizePageUrl(
  platform: SocialPlatform,
  remoteId: string,
  note: UnknownRecord,
  xsecToken: string,
): string | undefined {
  const video = asRecord(note.video);
  const direct = absoluteUrl(note.page_url) ?? absoluteUrl(video?.page_url) ?? absoluteUrl(video?.pageUrl);
  if (direct) return direct;
  // Link shapes live in the contracts platform schema, so a new platform or a changed URL format
  // is fixed in one place instead of being re-derived here.
  const canonical = buildSocialLink(platform, remoteId);
  if (!canonical) return undefined;
  // 小红书 needs the feed token to open the note when it was captured from the feed.
  if (platform === 'xhs' && xsecToken) {
    return `${canonical}?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_feed`;
  }
  return canonical;
}

function normalizeComments(value: unknown): LibraryComment[] {
  const comments: LibraryComment[] = [];
  for (const raw of asArray(value)) {
    const record = asRecord(raw);
    if (!record) continue;
    const id = text(record.cid) || text(record.id);
    const body = text(record.text) || text(record.content);
    if (!id || !body) continue;
    comments.push({
      id,
      text: body,
      author: text(record.user_name) || text(record.author) || undefined,
      likes: int(record.like_count ?? record.likes),
      replies: int(record.sub_comment_count ?? record.replies),
      createdAt: timestamp(record.create_time ?? record.createdAt),
      ipLocation: text(record.ip_label) || undefined,
    });
  }
  return dedupeComments(comments).slice(0, MAX_COMMENTS);
}

function dedupeComments(comments: LibraryComment[]): LibraryComment[] {
  const map = new Map<string, LibraryComment>();
  for (const comment of comments) map.set(comment.id, comment);
  return [...map.values()];
}

function normalizeNoteItem(
  raw: unknown,
  platform: SocialPlatform,
  comments: unknown,
  batchId: string,
): LibraryItem | null {
  const note = asRecord(raw);
  if (!note) return null;
  // A post link is often the only identifier an export carries (e.g. a share-sheet capture);
  // the platform schema turns it back into the id the library is keyed by.
  const linked = parseSocialLink(text(note.page_url));
  const remoteId = text(note.note_id) || text(note.aweme_id) || text(note.id) || linked?.remoteId;
  if (!remoteId) return null;

  const images = normalizeImages(note, platform);
  const video = asRecord(note.video);
  const author = asRecord(note.author);
  const authorName = text(note.author) || text(author?.name) || text(author?.nickname);
  // Snake_case is what the extension sends; the aliases keep captures from older builds and the
  // DOM fallback (which sees the page's own camelCase data) importable.
  const rawVideoUrl = text(video?.video_url) || text(video?.videoUrl) || text(video?.play_url)
    || text(note.video_url) || text(note.videoUrl);
  const videoUrl = absoluteUrl(rawVideoUrl);
  const duration = int(video?.duration ?? note.duration) || undefined;
  const normalizedComments = normalizeComments(comments);
  const now = Date.now();

  return {
    id: `${platform}:${remoteId}`,
    platform,
    kind: 'note',
    remoteId,
    title: text(note.title) || text(note.desc).slice(0, 80),
    desc: text(note.desc) || text(note.title),
    author: authorName || text(note.author_id)
      ? { id: text(note.author_id) || undefined, name: authorName || undefined }
      : undefined,
    coverUrl: images[0],
    images,
    videoUrl,
    videoUrls: Array.from(new Set(
      [videoUrl, ...asArray(video?.video_urls), ...asArray(video?.videoUrls)]
        .map((item) => absoluteUrl(item))
        .filter((url): url is string => Boolean(url)),
    )).slice(0, 12),
    duration,
    width: int(video?.width) || undefined,
    height: int(video?.height) || undefined,
    tags: Array.from(new Set(asArray(note.tags).map((tag) => text(tag)).filter(Boolean))).slice(0, 30),
    metrics: {
      likes: int(note.like_count),
      collects: int(note.collect_count),
      comments: int(note.comment_count),
      shares: int(note.share_count),
    },
    publishedAt: timestamp(note.time),
    ipLocation: text(note.ip_location) || undefined,
    source: text(note.source) || undefined,
    pageUrl: normalizePageUrl(platform, remoteId, note, ''),
    comments: normalizedComments,
    capturedCommentCount: normalizedComments.length,
    importedAt: now,
    updatedAt: now,
    batchId,
  };
}

function normalizeCardItem(
  raw: unknown,
  platform: SocialPlatform,
  batchId: string,
): LibraryItem | null {
  const card = asRecord(raw);
  if (!card) return null;
  const linked = parseSocialLink(text(card.page_url));
  const remoteId = text(card.note_id) || text(card.aweme_id) || text(card.id) || linked?.remoteId;
  if (!remoteId) return null;
  const cover = absoluteUrl(card.cover_url) ?? absoluteUrl(card.cover);
  const authorName = text(card.author) || text(asRecord(card.author)?.name);
  const now = Date.now();

  return {
    id: `${platform}:${remoteId}`,
    platform,
    kind: 'card',
    remoteId,
    title: text(card.title),
    desc: '',
    author: authorName
      ? { id: text(card.author_id) || undefined, name: authorName }
      : undefined,
    coverUrl: cover,
    images: cover ? [cover] : [],
    tags: [],
    metrics: {
      likes: int(card.liked_count ?? card.like_count),
      collects: 0,
      comments: 0,
      shares: 0,
    },
    pageUrl: normalizePageUrl(platform, remoteId, card, text(card.xsec_token)),
    capturedCommentCount: 0,
    comments: [],
    importedAt: now,
    updatedAt: now,
    batchId,
  };
}

/** Merge when the same item appears multiple times (e.g. user.notes and top-level notes);
 * detail beats card. */
function mergeItems(existing: LibraryItem, incoming: LibraryItem): LibraryItem {
  const images = Array.from(new Set([...incoming.images, ...existing.images])).slice(0, MAX_IMAGES);
  const comments = dedupeComments([
    ...(incoming.comments ?? []),
    ...(existing.comments ?? []),
  ]).slice(0, MAX_COMMENTS);
  const videoUrls = Array.from(new Set([
    ...(incoming.videoUrls ?? []),
    ...(existing.videoUrls ?? []),
  ])).slice(0, 12);
  return {
    ...existing,
    ...incoming,
    kind: existing.kind === 'note' || incoming.kind === 'note' ? 'note' : 'card',
    title: incoming.title || existing.title,
    desc: incoming.desc || existing.desc,
    author: incoming.author?.name ? incoming.author : existing.author,
    coverUrl: incoming.coverUrl ?? existing.coverUrl,
    images,
    videoUrl: incoming.videoUrl ?? existing.videoUrl,
    videoUrls,
    duration: incoming.duration ?? existing.duration,
    width: incoming.width ?? existing.width,
    height: incoming.height ?? existing.height,
    tags: Array.from(new Set([...incoming.tags, ...existing.tags])).slice(0, 30),
    metrics: {
      likes: incoming.metrics.likes || existing.metrics.likes,
      collects: incoming.metrics.collects || existing.metrics.collects,
      comments: incoming.metrics.comments || existing.metrics.comments,
      shares: incoming.metrics.shares || existing.metrics.shares,
    },
    publishedAt: incoming.publishedAt ?? existing.publishedAt,
    ipLocation: incoming.ipLocation ?? existing.ipLocation,
    pageUrl: incoming.pageUrl ?? existing.pageUrl,
    comments,
    capturedCommentCount: comments.length,
  };
}

/** Per-item platform: the item's own field, then its post link, then the batch default. */
function platformForItem(
  record: UnknownRecord | null,
  fallback: SocialPlatform | null,
): SocialPlatform {
  return normalizeSocialPlatform(record?.platform)
    ?? parseSocialLink(text(record?.page_url))?.platform
    ?? fallback
    ?? 'xhs';
}

export function normalizeImport(
  input: LibraryImportRequest,
  batchId: string,
): { items: LibraryItem[]; platform: SocialPlatform | null } {
  const topNotes = asArray(input.notes);
  const topCards = asArray(input.cards);
  const platform = inferPlatform(input, [...topNotes, ...topCards]);
  const items = new Map<string, LibraryItem>();

  const add = (item: LibraryItem | null) => {
    if (!item) return;
    const existing = items.get(item.id);
    items.set(item.id, existing ? mergeItems(existing, item) : item);
  };

  for (const note of topNotes) {
    const notePlatform = platformForItem(asRecord(note), platform);
    add(normalizeNoteItem(note, notePlatform, input.comments?.[text(asRecord(note)?.note_id)], batchId));
  }
  for (const card of topCards) {
    add(normalizeCardItem(card, platformForItem(asRecord(card), platform), batchId));
  }
  for (const userRaw of asArray(input.users)) {
    const user = asRecord(userRaw);
    if (!user) continue;
    for (const note of asArray(user.notes)) {
      const noteId = text(asRecord(note)?.note_id);
      const comments = asRecord(user.comments)?.[noteId];
      add(normalizeNoteItem(note, platformForItem(asRecord(note), platform), comments, batchId));
    }
    for (const card of asArray(user.cards)) {
      add(normalizeCardItem(card, platformForItem(asRecord(card), platform), batchId));
    }
  }
  for (const generic of asArray(input.items)) {
    const record = asRecord(generic);
    if (!record) continue;
    const itemPlatform = platformForItem(record, platform);
    if (record.kind === 'card' || record.cover_url) {
      add(normalizeCardItem(record, itemPlatform, batchId));
    } else {
      add(normalizeNoteItem(record, itemPlatform, record.comments, batchId));
    }
  }

  return { items: [...items.values()], platform };
}

// ── Persistence ─────────────────────────────────────────────────────────────

interface LibraryRow {
  id: string;
  payload: string;
}

function parseItem(raw: string): LibraryItem {
  return JSON.parse(raw) as LibraryItem;
}

function toSummary(item: LibraryItem): LibraryItemSummary {
  const { comments: _comments, videoUrls: _videoUrls, ...rest } = item;
  return rest;
}

export function importLibraryItems(
  db: Database.Database,
  input: LibraryImportRequest,
  options: { source: string; label?: string },
): LibraryImportResult {
  const batchId = `lib_${randomUUID()}`;
  const now = Date.now();
  const { items, platform } = normalizeImport(input, batchId);
  if (items.length === 0) {
    const batch: LibraryBatch = {
      id: batchId,
      platform: platform ?? 'mixed',
      source: options.source,
      itemCount: 0,
      createdAt: now,
      label: options.label,
    };
    return { batch, created: 0, updated: 0, skipped: 0 };
  }

  const platforms = new Set(items.map((item) => item.platform));
  const batchPlatform: LibraryBatch['platform'] = platforms.size === 1
    ? [...platforms][0]!
    : 'mixed';

  const select = db.prepare('SELECT id, payload FROM library_items WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO library_items
      (id, platform, kind, remote_id, title, author_name, cover_url, tags, published_at, imported_at, updated_at, batch_id, payload)
     VALUES (@id, @platform, @kind, @remoteId, @title, @authorName, @coverUrl, @tags, @publishedAt, @importedAt, @updatedAt, @batchId, @payload)`,
  );
  const update = db.prepare(
    `UPDATE library_items SET
      platform = @platform, kind = @kind, remote_id = @remoteId, title = @title,
      author_name = @authorName, cover_url = @coverUrl, tags = @tags,
      published_at = @publishedAt, imported_at = @importedAt, updated_at = @updatedAt,
      batch_id = @batchId, payload = @payload
     WHERE id = @id`,
  );

  let created = 0;
  let updated = 0;

  const run = db.transaction(() => {
    for (const item of items) {
      const row = select.get(item.id) as LibraryRow | undefined;
      if (row) {
        let merged = item;
        try {
          merged = mergeItems(parseItem(row.payload), item);
        } catch {
          merged = item;
        }
        const latest: LibraryItem = {
          ...merged,
          // Take the latest import time so a re-import jumps back to the top under
          // 'recently imported' sort.
          importedAt: now,
          updatedAt: now,
          batchId,
        };
        update.run(toRow(latest));
        updated += 1;
      } else {
        insert.run(toRow(item));
        created += 1;
      }
    }
  });
  run();

  const batch: LibraryBatch = {
    id: batchId,
    platform: batchPlatform,
    source: options.source,
    itemCount: items.length,
    createdAt: now,
    label: options.label,
  };
  db.prepare(
    `INSERT INTO library_batches (id, platform, source, item_count, created_at, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(batch.id, batch.platform, batch.source, batch.itemCount, batch.createdAt, batch.label ?? null);

  return { batch, created, updated, skipped: 0 };
}

function toRow(item: LibraryItem): Record<string, unknown> {
  return {
    id: item.id,
    platform: item.platform,
    kind: item.kind,
    remoteId: item.remoteId,
    title: item.title,
    authorName: item.author?.name ?? null,
    coverUrl: item.coverUrl ?? null,
    tags: item.tags.join(' '),
    publishedAt: item.publishedAt ?? null,
    importedAt: item.importedAt,
    updatedAt: item.updatedAt,
    batchId: item.batchId ?? null,
    payload: JSON.stringify(item),
  };
}

export function listLibraryItems(
  db: Database.Database,
  query: LibraryListQuery,
): LibraryListResponse {
  const platform = query.platform && query.platform !== 'all' ? query.platform : null;
  const q = (query.q ?? '').trim().toLowerCase();
  const where: string[] = [];
  const params: unknown[] = [];
  if (platform) {
    where.push('platform = ?');
    params.push(platform);
  }
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    where.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(tags) LIKE ? ESCAPE '\\' OR LOWER(payload) LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const limit = Math.min(Math.max(query.limit ?? 60, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);
  const order = query.sort === 'published'
    ? 'COALESCE(published_at, 0) DESC, imported_at DESC'
    : query.sort === 'likes'
      ? "CAST(json_extract(payload, '$.metrics.likes') AS INTEGER) DESC, imported_at DESC"
      : 'imported_at DESC';

  const rows = db.prepare(
    `SELECT payload FROM library_items ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as { payload: string }[];

  const total = (db.prepare(`SELECT COUNT(*) AS count FROM library_items ${whereSql}`)
    .get(...params) as { count: number }).count;

  const counts: LibraryCounts = { all: 0, xhs: 0, bilibili: 0, douyin: 0, pinterest: 0 };
  const countRows = db.prepare('SELECT platform, COUNT(*) AS count FROM library_items GROUP BY platform')
    .all() as { platform: SocialPlatform; count: number }[];
  for (const row of countRows) {
    counts[row.platform] = row.count;
    counts.all += row.count;
  }

  return {
    items: rows.map((row) => toSummary(parseItem(row.payload))),
    total,
    counts,
  };
}

export function getLibraryItem(db: Database.Database, id: string): LibraryItem | null {
  const row = db.prepare('SELECT payload FROM library_items WHERE id = ?').get(id) as { payload: string } | undefined;
  return row ? parseItem(row.payload) : null;
}

export function deleteLibraryItem(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM library_items WHERE id = ?').run(id).changes > 0;
}

export function clearLibraryItems(db: Database.Database): number {
  return db.prepare('DELETE FROM library_items').run().changes;
}

export function listLibraryBatches(db: Database.Database, limit = 20): LibraryBatch[] {
  const rows = db.prepare(
    `SELECT * FROM library_batches ORDER BY created_at DESC LIMIT ?`,
  ).all(Math.min(Math.max(limit, 1), 100)) as {
    id: string; platform: LibraryBatch['platform']; source: string; item_count: number; created_at: number; label: string | null;
  }[];
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    source: row.source,
    itemCount: row.item_count,
    createdAt: row.created_at,
    label: row.label ?? undefined,
  }));
}

export function latestImportAt(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(imported_at) AS latest FROM library_items').get() as { latest: number | null };
  return row.latest ?? 0;
}

// ── Media hotlink protection ────────────────────────────────────────────────

/**
 * Known social-media CDN suffixes: the media proxy and video download share one allowlist
 * (anti-SSRF).
 */
const MEDIA_HOST_ALLOWLIST = [
  'xhscdn.com',
  'xiaohongshu.com',
  'hdslb.com',
  'bilibili.com',
  'bilivideo.com',
  // Bilibili's PCDN/DASH nodes answer on .cn too (e.g. *.mcdn.bilivideo.cn); playurl hands those
  // out for the same video, so a .com-only allowlist rejects valid downloads.
  'bilivideo.cn',
  'szbdyd.com',
  'douyinpic.com',
  'douyinvod.com',
  'douyin.com',
  'byteimg.com',
  'pstatp.com',
  'zjcdn.com',
  'snssdk.com',
  'bytecdn.cn',
  'bytedance.com',
  'ixigua.com',
  'amemv.com',
  // Pinterest serves every pin image/video from i.pinimg.com and its regional mirrors.
  'pinimg.com',
  'pinterest.com',
];

export function isAllowedMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // For local testing / private deploys, append domains via REMIXCLIP_MEDIA_HOSTS
  // (comma-separated); default is social CDNs only.
  const extra = (process.env.REMIXCLIP_MEDIA_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...MEDIA_HOST_ALLOWLIST, ...extra]
    .some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Social CDNs check referer: map the domain back to its site homepage; both download and
 * proxy must send it.
 */
export function mediaReferer(hostname: string): string {
  const host = hostname.toLowerCase();
  if (host.includes('xhscdn') || host.includes('xiaohongshu')) return 'https://www.xiaohongshu.com/';
  if (host.includes('hdslb') || host.includes('bilibili') || host.includes('bilivideo')) return 'https://www.bilibili.com/';
  if (host.includes('pinimg') || host.includes('pinterest')) return 'https://www.pinterest.com/';
  return 'https://www.douyin.com/';
}
