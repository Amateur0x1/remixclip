/**
 * [INPUT]: the daemon's library REST API and the extension pairing protocol.
 * [OUTPUT]: typed library queries, imports, deletions, pairing and media proxy URLs (every
 *           response goes through its zod schema).
 * [POS]: the web library client; all remote media goes through the same-origin proxy.
 */
import type {
  Comparison,
  LibraryAnalyzeResponse,
  LibraryCompareRequest,
  LibraryCompareResponse,
  LibraryComparisonListResponse,
  LibraryImportRequest,
  LibraryImportResult,
  LibraryItem,
  LibraryListQuery,
  LibraryListResponse,
  LibraryPairingInfo,
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
  libraryImportResultSchema,
  libraryItemResponseSchema,
  libraryListResponseSchema,
  libraryMediaFileResponseSchema,
  libraryMediaListResponseSchema,
  libraryOkResponseSchema,
  libraryPairingInfoSchema,
  libraryPairWindowSchema,
  libraryShotsResponseSchema,
} from '@remixclip/contracts';
import { t, type DictKey } from '@/i18n';

async function readError(res: Response, fallback: DictKey): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? t('errors.httpSuffix', { fallback: t(fallback), status: res.status });
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

export async function fetchPairing(): Promise<LibraryPairingInfo> {
const res = await fetch('/api/library/pairing');
if (!res.ok) throw new Error(await readError(res, 'errors.pairingFetch'));
return parseBody(libraryPairingInfoSchema, await readJson(res, 'errors.pairingFetch'), 'errors.pairingLabel');
}

/**
 * Open the 2-minute window in which the browser extension may pair without typing a code.
 * The user clicks the button, so consent is explicit; the daemon enforces the TTL and that the
 * pairing request carries a chrome-extension origin.
 */
export async function openPairWindow(): Promise<number> {
const res = await fetch('/api/library/pair-window', { method: 'POST' });
if (!res.ok) throw new Error(await readError(res, 'errors.pairingFetch'));
const body = parseBody(libraryPairWindowSchema, await readJson(res, 'errors.pairingFetch'), 'errors.pairingLabel');
return body.expiresAt;
}

export async function revokeDevice(id: string): Promise<void> {
  const res = await fetch(`/api/library/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res, 'errors.deviceRevoke'));
  parseBody(libraryOkResponseSchema, await readJson(res, 'errors.deviceRevoke'), 'errors.deviceRevokeLabel');
}

/** Social CDNs need a referer, so this always goes through the daemon proxy; empty URLs pass through. */
export function mediaUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return url;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return `/api/library/media?url=${encodeURIComponent(url)}`;
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
