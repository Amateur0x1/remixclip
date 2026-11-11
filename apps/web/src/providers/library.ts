/**
 * [INPUT]: the daemon's library REST API.
 * [OUTPUT]: typed library queries, imports, deletions, connection info and media proxy URLs (every
 *           response goes through its zod schema).
 * [POS]: the web library client; all remote media goes through the same-origin proxy.
 */
import type {
  Comparison,
  LibraryAnalyzeResponse,
  LibraryCompareRequest,
  LibraryCompareResponse,
  LibraryComparisonListResponse,
  LibraryConnectionInfo,
  LibraryDownloadEntry,
  LibraryImportRequest,
  LibraryImportResult,
  LibraryItem,
  LibraryListQuery,
  LibraryListResponse,
  LibraryOkResponse,
  LibraryShotsResponse,
  MediaFile,
  SocialPlatform,
} from '@remixclip/contracts';
import {
  libraryAnalyzeResponseSchema,
  libraryCompareResponseSchema,
  libraryComparisonListResponseSchema,
  libraryComparisonResponseSchema,
  libraryConnectionInfoSchema,
  libraryDownloadsResponseSchema,
  libraryImportResultSchema,
  libraryItemResponseSchema,
  libraryListResponseSchema,
  libraryMediaFileResponseSchema,
  libraryMediaListResponseSchema,
  libraryOkResponseSchema,
  libraryShotsResponseSchema,
} from '@remixclip/contracts';
import { t, type DictKey } from '@/i18n';

async function readError(res: Response, fallback: DictKey): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (body?.error) return body.error;
  const suffix = t('errors.httpSuffix', { fallback: t(fallback), status: res.status });
  // A 5xx without a JSON error means the request never reached the daemon (proxy/daemon down);
  // "HTTP 500" on its own reads like a CDN failure and sends people hunting the wrong thing.
  return res.status >= 500 ? `${suffix} · ${t('errors.backendUnavailable')}` : suffix;
}

/**
 * Parse the response body against the contracts schema: a daemon/web version mismatch surfaces
 * immediately at the boundary (instead of a missing field leaking into the render layer and
 * crashing on undefined).
 */
function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } },
  raw: unknown,
  label: DictKey,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.join('.') ?? '';
  throw new Error(t(
    field ? 'errors.contractMismatchField' : 'errors.contractMismatch',
    field ? { label: t(label), field } : { label: t(label) },
  ));
}

async function readJson(res: Response, fallback: DictKey): Promise<unknown> {
  const raw = (await res.json().catch(() => null)) as unknown;
  if (raw == null) throw new Error(t('errors.notJson', { fallback: t(fallback) }));
  return raw;
}

export async function listLibrary(query: LibraryListQuery): Promise<LibraryListResponse> {
  const params = new URLSearchParams();
  if (query.platform && query.platform !== 'all') params.set('platform', query.platform);
  if (query.q?.trim()) params.set('q', query.q.trim());
  if (query.sort) params.set('sort', query.sort);
  params.set('limit', String(query.limit ?? 60));
  params.set('offset', String(query.offset ?? 0));
  const res = await fetch(`/api/library/items?${params.toString()}`);
  if (!res.ok) throw new Error(await readError(res, 'errors.libraryRead'));
  return parseBody(libraryListResponseSchema, await readJson(res, 'errors.libraryRead'), 'errors.libraryListLabel');
}

export async function getLibraryItem(id: string): Promise<LibraryItem> {
  const res = await fetch(`/api/library/items/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await readError(res, 'errors.libraryDetailRead'));
  const data = parseBody(libraryItemResponseSchema, await readJson(res, 'errors.libraryDetailRead'), 'errors.libraryDetailLabel');
  return data.item;
}

export async function deleteLibraryItem(id: string): Promise<void> {
  const res = await fetch(`/api/library/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'errors.libraryDelete'));
}

export async function clearLibrary(): Promise<number> {
  const res = await fetch('/api/library/items', { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'errors.libraryClear'));
  const data: LibraryOkResponse = parseBody(
    libraryOkResponseSchema,
    await readJson(res, 'errors.libraryClear'),
    'errors.libraryClearLabel',
  );
  return data.removed ?? 0;
}

export async function importLibraryPayload(payload: LibraryImportRequest): Promise<LibraryImportResult> {
  const res = await fetch('/api/library/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await readError(res, 'errors.libraryImport'));
  return parseBody(libraryImportResultSchema, await readJson(res, 'errors.libraryImport'), 'errors.libraryImportLabel');
}

/**
 * The daemon's bound port plus the companions that greeted it recently. There is no pairing step:
 * the extension only needs the port, and its heartbeat proves the port reached this daemon.
 */
export async function fetchConnection(): Promise<LibraryConnectionInfo> {
const res = await fetch('/api/library/connection');
if (!res.ok) throw new Error(await readError(res, 'errors.connectionFetch'));
return parseBody(libraryConnectionInfoSchema, await readJson(res, 'errors.connectionFetch'), 'errors.connectionLabel');
}

/** Social CDNs need a referer, so this always goes through the daemon proxy; empty URLs pass through. */
export function mediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return url;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return `/api/library/media?url=${encodeURIComponent(url)}`;
}

/**
 * Signed social-media URLs carry their own expiry (`deadline` on Bilibili, `expire` on Douyin).
 * Reading it lets the preview say "expired, capture it again" instead of rendering a dead player.
 * Returns null when the URL is unsigned or the parameter is not a plausible epoch second.
 */
export function mediaUrlExpiresAt(url: string | undefined): number | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const key of ['deadline', 'expire', 'expires', 'x-expires']) {
    const raw = parsed.searchParams.get(key);
    if (!raw || !/^\d+$/.test(raw)) continue;
    const value = Number(raw);
    if (value > 1_000_000_000 && value < 100_000_000_000) return value * 1000;
  }
  return null;
}

// ── local video / shot analysis / pixel comparison ───────────────────────

/** An absolute local path goes through the same-origin proxy (thumbnail / comparison frame / diff image / registered render). */
export function localMediaUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return `/api/library/media?src=${encodeURIComponent(path)}`;
}

function itemPath(id: string): string {
  return `/api/library/items/${encodeURIComponent(id)}`;
}

/** Trigger the source-video download (idempotent: returns the existing record when already downloading/ready). */
export async function downloadLibraryVideo(id: string): Promise<MediaFile> {
  const res = await fetch(`${itemPath(id)}/download`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'errors.mediaDownload'));
  return parseBody(libraryMediaFileResponseSchema, await readJson(res, 'errors.mediaDownload'), 'errors.mediaDownloadLabel').media;
}

/** Global download feed for the header centre: in-flight rows plus the last day's results. */
export async function listLibraryDownloads(): Promise<LibraryDownloadEntry[]> {
  const res = await fetch('/api/library/downloads', { cache: 'no-store' });
  if (!res.ok) throw new Error(await readError(res, 'errors.mediaListRead'));
  const data = parseBody(
    libraryDownloadsResponseSchema,
    await readJson(res, 'errors.mediaListRead'),
    'errors.mediaListLabel',
  );
  return data.downloads;
}

export async function listLibraryMedia(id: string): Promise<MediaFile[]> {
  const res = await fetch(`${itemPath(id)}/media`);
  if (!res.ok) throw new Error(await readError(res, 'errors.mediaListRead'));
  const data = parseBody(
    libraryMediaListResponseSchema,
    await readJson(res, 'errors.mediaListRead'),
    'errors.mediaListLabel',
  );
  return data.media;
}

export async function deleteLibraryMedia(id: string, mediaId: string): Promise<void> {
  const res = await fetch(`${itemPath(id)}/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'errors.mediaDelete'));
}

export async function analyzeLibraryShots(id: string): Promise<LibraryAnalyzeResponse> {
  const res = await fetch(`${itemPath(id)}/analyze`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'errors.analyze'));
  return parseBody(libraryAnalyzeResponseSchema, await readJson(res, 'errors.analyze'), 'errors.analyzeLabel');
}

export async function getLibraryShots(id: string): Promise<LibraryShotsResponse> {
  const res = await fetch(`${itemPath(id)}/shots`);
  if (!res.ok) throw new Error(await readError(res, 'errors.shotsRead'));
  return parseBody(libraryShotsResponseSchema, await readJson(res, 'errors.shotsRead'), 'errors.shotsLabel');
}

/** Renders are uploaded as a raw video stream, avoiding a multipart dependency. */
export async function uploadLibraryRender(id: string, file: File | Blob, filename: string): Promise<MediaFile> {
  const name = filename || 'render.mp4';
  const res = await fetch(`${itemPath(id)}/renders?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'video/mp4' },
    body: file,
  });
  if (!res.ok) throw new Error(await readError(res, 'errors.renderUpload'));
  return parseBody(libraryMediaFileResponseSchema, await readJson(res, 'errors.renderUpload'), 'errors.renderLabel').media;
}

export async function startLibraryComparison(
  id: string,
  input: LibraryCompareRequest,
): Promise<LibraryCompareResponse> {
  const res = await fetch(`${itemPath(id)}/compare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res, 'errors.compareStart'));
  return parseBody(libraryCompareResponseSchema, await readJson(res, 'errors.compareStart'), 'errors.compareLabel');
}

export async function listLibraryComparisons(id: string): Promise<LibraryComparisonListResponse> {
  const res = await fetch(`${itemPath(id)}/comparisons`);
  if (!res.ok) throw new Error(await readError(res, 'errors.comparisonsRead'));
  return parseBody(
    libraryComparisonListResponseSchema,
    await readJson(res, 'errors.comparisonsRead'),
    'errors.comparisonsLabel',
  );
}

export async function getLibraryComparison(id: string): Promise<Comparison> {
  const res = await fetch(`/api/library/comparisons/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await readError(res, 'errors.comparisonRead'));
  return parseBody(
    libraryComparisonResponseSchema,
    await readJson(res, 'errors.comparisonRead'),
    'errors.comparisonLabel',
  ).comparison;
}

/**
 * Platform display names keep only a labelKey: the UI always goes through the dictionary, so
 * language/brand names are not duplicated here.
 * There used to be a Chinese `short` field with no call sites; it was removed so it would not
 * become dead copy that translations never reach.
 */
export const PLATFORM_META: Record<SocialPlatform, { labelKey: DictKey; color: string }> = {
  xhs: { labelKey: 'platform.xhs', color: '#ff2442' },
  bilibili: { labelKey: 'platform.bilibili', color: '#00aeec' },
  douyin: { labelKey: 'platform.douyin', color: '#161823' },
};

export function platformMeta(platform: SocialPlatform) {
  return PLATFORM_META[platform];
}

/** Platform display name (in the current UI locale). */
export function platformLabel(platform: SocialPlatform): string {
  return t(PLATFORM_META[platform].labelKey);
}
