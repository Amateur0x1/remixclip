/**
 * [INPUT]: Social media data (Xiaohongshu / Bilibili / Douyin) exported by the browser extension and the
 *          HTTP payloads exchanged with web/daemon.
 * [OUTPUT]: The library zod schemas (the single validation source across process boundaries) and
 *           types derived from them.
 * [POS]: Cross-end contract for the workbench "library"; daemon uses parse to validate input, web uses
 *        the same schemas to validate responses.
 */

import { z } from 'zod';

// ── Platform ───────────────────────────────────────────────────────────────

export const SOCIAL_PLATFORMS = ['xhs', 'bilibili', 'douyin'] as const;

export const socialPlatformSchema = z.enum(SOCIAL_PLATFORMS);

export type SocialPlatform = z.infer<typeof socialPlatformSchema>;

/** List filter option: a platform plus the `all` option. */
export const LIBRARY_PLATFORM_FILTERS = ['all', ...SOCIAL_PLATFORMS] as const;

/** Error message for the platform filter (an unknown platform is a client bug and should not
 *  silently degrade to the `all` option). */
const platformFilterSchema = z.enum(LIBRARY_PLATFORM_FILTERS, {
  errorMap: () => ({ message: '不支持的平台，只接受 all / xhs / bilibili / douyin' }),
});

export const LIBRARY_SORTS = ['imported', 'published', 'likes'] as const;

export const librarySortSchema = z.enum(LIBRARY_SORTS);

export type LibrarySort = z.infer<typeof librarySortSchema>;

const PLATFORM_ALIASES: Record<string, SocialPlatform> = {
  xhs: 'xhs',
  xiaohongshu: 'xhs',
  rednote: 'xhs',
  bilibili: 'bilibili',
  bili: 'bilibili',
  douyin: 'douyin',
  dy: 'douyin',
};

/**
 * The extension has historically used aliases such as `xiaohongshu` / `rednote` / `bili` / `dy`;
 * unknown platforms return null (the caller falls back to inferring from the filename) rather than
 * being treated as an error.
 */
export function normalizeSocialPlatform(value: unknown): SocialPlatform | null {
  if (typeof value !== 'string') return null;
  return PLATFORM_ALIASES[value.trim().toLowerCase()] ?? null;
}

// ── Items ──────────────────────────────────────────────────────────────────

/** note = detail/feed note; card = card grabbed only from the creator's profile page (less info). */
export const libraryItemKindSchema = z.enum(['note', 'card']);

export type LibraryItemKind = z.infer<typeof libraryItemKindSchema>;

export const libraryAuthorSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  avatar: z.string().optional(),
});

export type LibraryAuthor = z.infer<typeof libraryAuthorSchema>;

export const libraryCommentSchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  likes: z.number(),
  replies: z.number(),
  createdAt: z.number().optional(),
  ipLocation: z.string().optional(),
});

export type LibraryComment = z.infer<typeof libraryCommentSchema>;

export const libraryMetricsSchema = z.object({
  likes: z.number(),
  collects: z.number(),
  comments: z.number(),
  shares: z.number(),
});

export type LibraryMetrics = z.infer<typeof libraryMetricsSchema>;

/** One entry in the library (one social media post per import). */
export const libraryItemSchema = z.object({
  /** `${platform}:${remoteId}`, deduplicated across batches. */
  id: z.string(),
  platform: socialPlatformSchema,
  kind: libraryItemKindSchema,
  remoteId: z.string(),
  title: z.string(),
  desc: z.string(),
  author: libraryAuthorSchema.optional(),
  /** Remote cover; the frontend reads it through the daemon media proxy to avoid hotlink blocking. */
  coverUrl: z.string().optional(),
  images: z.array(z.string()),
  videoUrl: z.string().optional(),
  videoUrls: z.array(z.string()).optional(),
  duration: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  tags: z.array(z.string()),
  metrics: libraryMetricsSchema,
  /** Original post publish time (milliseconds). */
  publishedAt: z.number().optional(),
  ipLocation: z.string().optional(),
  source: z.string().optional(),
  /** Original post URL (for the `open original post` action). */
  pageUrl: z.string().optional(),
  /** Comments already captured (returned by the detail API, omitted by the list API). */
  comments: z.array(libraryCommentSchema).optional(),
  capturedCommentCount: z.number(),
  importedAt: z.number(),
  updatedAt: z.number(),
  batchId: z.string().optional(),
});

export type LibraryItem = z.infer<typeof libraryItemSchema>;

/** List item: no comment bodies and no full video URLs, keeping the first screen lightweight. */
export const libraryItemSummarySchema = libraryItemSchema.omit({
  comments: true,
  videoUrls: true,
});

export type LibraryItemSummary = z.infer<typeof libraryItemSummarySchema>;

export const libraryCountsSchema = z.object({
  all: z.number(),
  xhs: z.number(),
  bilibili: z.number(),
  douyin: z.number(),
});

export type LibraryCounts = z.infer<typeof libraryCountsSchema>;

export const libraryListResponseSchema = z.object({
  items: z.array(libraryItemSummarySchema),
  total: z.number(),
  counts: libraryCountsSchema,
});

export type LibraryListResponse = z.infer<typeof libraryListResponseSchema>;

export const libraryItemResponseSchema = z.object({ item: libraryItemSchema });

export type LibraryItemResponse = z.infer<typeof libraryItemResponseSchema>;

/**
 * Query-string schema for GET /api/library/items: the HTTP side can only be strings,
 * so this handles coerce + range clamping; the daemon fills in defaults to match `LibraryListQuery`.
 */
export const libraryListQuerySchema = z.object({
  platform: platformFilterSchema.optional(),
  /** Over-long search terms are truncated (consistent with old behavior) rather than
   *  rejecting the whole request. */
  q: z
    .string()
    .transform((value) => value.trim().slice(0, 120))
    .optional()
    .catch(undefined),
  sort: librarySortSchema.optional(),
  limit: z.coerce
    .number({ invalid_type_error: 'limit 必须是数字' })
    .int('limit 必须是整数')
    .min(1, 'limit 最小 1')
    .max(200, 'limit 最大 200')
    .optional(),
  offset: z.coerce
    .number({ invalid_type_error: 'offset 必须是数字' })
    .int('offset 必须是整数')
    .min(0, 'offset 不能为负')
    .optional(),
});

export type LibraryListQueryInput = z.infer<typeof libraryListQuerySchema>;

export interface LibraryListQuery {
  platform?: SocialPlatform | 'all';
  q?: string;
  sort?: LibrarySort;
  limit?: number;
  offset?: number;
}

// ── Batches ────────────────────────────────────────────────────────────────

export const libraryBatchSchema = z.object({
  id: z.string(),
  platform: socialPlatformSchema.or(z.literal('mixed')),
  source: z.string(),
  itemCount: z.number(),
  createdAt: z.number(),
  label: z.string().optional(),
});

export type LibraryBatch = z.infer<typeof libraryBatchSchema>;

export const libraryBatchListResponseSchema = z.object({
  batches: z.array(libraryBatchSchema),
});

export type LibraryBatchListResponse = z.infer<typeof libraryBatchListResponseSchema>;

// ── Import ─────────────────────────────────────────────────────────────────

/**
 * Raw export body sent directly by the extension (matches the RemixClip Asset Helper downloadJson
 * structure); the daemon normalizes it into LibraryItems. The whole payload comes from an untrusted
 * extension / local file, so this only constrains shape and length limits; per-item fields are
 * tolerated by the store's normalization logic.
 */
export const libraryImportRequestSchema = z
  .object({
    /** Current platform from the extension; aliases are normalized, unknown platforms are dropped
     *  and then inferred from the filename. */
    platform: z.preprocess(
      (value) => normalizeSocialPlatform(value) ?? undefined,
      socialPlatformSchema.optional(),
    ),
    /** Used to infer the platform / batch name on file import. */
    filename: z.string().max(1024).optional(),
    exportedAt: z.string().max(64).optional(),
    source: z.string().max(64).optional(),
    notes: z.array(z.unknown()).optional(),
    cards: z.array(z.unknown()).optional(),
    users: z.array(z.unknown()).optional(),
    items: z.array(z.unknown()).optional(),
    comments: z.record(z.array(z.unknown())).optional(),
  })
  // Later extension versions may carry more fields for the daemon's normalization to consume;
  // do not silently drop them.
  .passthrough();

export type LibraryImportRequest = z.infer<typeof libraryImportRequestSchema>;

export const libraryImportResultSchema = z.object({
  batch: libraryBatchSchema,
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
});

export type LibraryImportResult = z.infer<typeof libraryImportResultSchema>;

// ── Pairing ────────────────────────────────────────────────────────────────

export const libraryDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  lastSeenAt: z.number().optional(),
});

export type LibraryDevice = z.infer<typeof libraryDeviceSchema>;

export const libraryPairingInfoSchema = z.object({
  /** Daemon address the extension should fill in, e.g. http://127.0.0.1:7456. */
  endpoint: z.string(),
  /** 6-digit one-time pairing code (case-insensitive). */
  code: z.string(),
  expiresAt: z.number(),
  devices: z.array(libraryDeviceSchema),
});

export type LibraryPairingInfo = z.infer<typeof libraryPairingInfoSchema>;

/** Request body schema for POST /api/library/pair.
 *
 * Two ways in:
 *   - `code`: the 6-char one-time code shown in the app (works from anywhere, incl. curl);
 *   - `auto: true`: extension-only shortcut that skips typing while the user has just opened the
 *     app's 2-minute auto-pair window (the daemon still checks the chrome-extension origin).
 */
export const libraryPairRequestSchema = z.object({
  code: z
    .string({ invalid_type_error: '缺少配对码' })
    .transform((value) => value.trim())
    .refine((value) => value.length > 0 && value.length <= 32, { message: '缺少配对码' })
    .optional(),
  /** Extension-origin only: pair without a code during the app's auto-pair window. */
  auto: z.boolean().optional(),
  /** Device name, defaults to `browser extension`. */
  client: z.string().max(80).optional(),
});

export type LibraryPairRequest = z.infer<typeof libraryPairRequestSchema>;

/** Response of POST /api/library/pair-window: how long extension auto-pairing is allowed. */
export const libraryPairWindowSchema = z.object({
  expiresAt: z.number(),
});

export type LibraryPairWindow = z.infer<typeof libraryPairWindowSchema>;

export const libraryPairResponseSchema = z.object({
  token: z.string(),
  device: libraryDeviceSchema,
  endpoint: z.string(),
});

export type LibraryPairResponse = z.infer<typeof libraryPairResponseSchema>;

// ── Local video (downloaded to disk) ───────────────────────────────────────

/** source = original social media video; render = agent replica output (any local mp4). */
export const MEDIA_FILE_KINDS = ['source', 'render'] as const;

export const mediaFileKindSchema = z.enum(MEDIA_FILE_KINDS);

export type MediaFileKind = z.infer<typeof mediaFileKindSchema>;

export const MEDIA_FILE_STATUSES = ['pending', 'downloading', 'ready', 'failed'] as const;

export const mediaFileStatusSchema = z.enum(MEDIA_FILE_STATUSES);

export type MediaFileStatus = z.infer<typeof mediaFileStatusSchema>;

export const mediaFileSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  kind: mediaFileKindSchema,
  /** Absolute path; the web side always reads it via /api/library/media?src=. */
  path: z.string(),
  bytes: z.number().optional(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fps: z.number().optional(),
  status: mediaFileStatusSchema,
  /** 0~1; always 1 once ready. */
  progress: z.number(),
  error: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type MediaFile = z.infer<typeof mediaFileSchema>;

export const libraryMediaFileResponseSchema = z.object({ media: mediaFileSchema });

export type LibraryMediaFileResponse = z.infer<typeof libraryMediaFileResponseSchema>;

export const libraryMediaListResponseSchema = z.object({ media: z.array(mediaFileSchema) });

export type LibraryMediaListResponse = z.infer<typeof libraryMediaListResponseSchema>;

// ── Shot breakdown (storyboard decomposition) ──────────────────────────────

export const shotSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  /** Zero-based, ascending by time. */
  index: z.number(),
  startMs: z.number(),
  endMs: z.number(),
  /** Absolute path of the frame at the 50% position; accessed via /api/library/media?src=. */
  thumbnailPath: z.string().optional(),
  /** Left for the agent to fill with visual description / camera motion / subject / subtitles;
   *  always empty at this stage. */
  analysis: z.unknown().optional(),
});

export type Shot = z.infer<typeof shotSchema>;

export const SHOT_JOB_STATUSES = ['running', 'ready', 'failed'] as const;

export const shotJobStatusSchema = z.enum(SHOT_JOB_STATUSES);

export type ShotJobStatus = z.infer<typeof shotJobStatusSchema>;

export const shotJobSchema = z.object({
  jobId: z.string(),
  status: shotJobStatusSchema,
  error: z.string().optional(),
});

export type ShotJob = z.infer<typeof shotJobSchema>;

export const libraryAnalyzeResponseSchema = z.object({
  jobId: z.string(),
  status: z.literal('running'),
});

export type LibraryAnalyzeResponse = z.infer<typeof libraryAnalyzeResponseSchema>;

/** shots + the reference source video + the current shot-breakdown job (the frontend uses this to
 *  decide between the `analyzing…` state and rendering the timeline). */
export const libraryShotsResponseSchema = z.object({
  shots: z.array(shotSchema),
  media: mediaFileSchema.nullable(),
  job: shotJobSchema.nullable(),
});

export type LibraryShotsResponse = z.infer<typeof libraryShotsResponseSchema>;

// ── Pixel comparison (pixelmatch) ──────────────────────────────────────────

export const COMPARISON_SHOT_STATUSES = ['match', 'minor', 'mismatch'] as const;

export const comparisonShotStatusSchema = z.enum(COMPARISON_SHOT_STATUSES);

export type ComparisonShotStatus = z.infer<typeof comparisonShotStatusSchema>;

/** The three tiers other than failed / structure-mismatch share thresholds
 *  with per-shot classification. */
export const COMPARISON_STATUSES = [
  'running',
  'match',
  'minor',
  'mismatch',
  'structure-mismatch',
  'failed',
] as const;

export const comparisonStatusSchema = z.enum(COMPARISON_STATUSES);

export type ComparisonStatus = z.infer<typeof comparisonStatusSchema>;

export const comparisonFrameSchema = z.object({
  atMs: z.number(),
  score: z.number(),
  /** Share of perceptually different pixels (threshold 0.1, anti-aliasing ignored). */
  perceptualRatio: z.number(),
  /** Share of strictly different pixels (threshold 0, anti-aliasing included). */
  exactRatio: z.number(),
  /** Local absolute paths of the three-column comparison image, always served via
   *  /api/library/media?src=. */
  sourcePath: z.string().optional(),
  renderPath: z.string().optional(),
  diffPath: z.string().optional(),
});

export type ComparisonFrame = z.infer<typeof comparisonFrameSchema>;

export const comparisonShotSchema = z.object({
  index: z.number(),
  startMs: z.number(),
  endMs: z.number(),
  score: z.number(),
  status: comparisonShotStatusSchema,
  frames: z.array(comparisonFrameSchema),
});

export type ComparisonShot = z.infer<typeof comparisonShotSchema>;

export const comparisonReportSchema = z.object({
  shots: z.array(comparisonShotSchema),
  sourceShotCount: z.number(),
  renderShotCount: z.number(),
  /** Aligned target size (width × height 480). */
  width: z.number().optional(),
  height: z.number().optional(),
  /** Failure reason; on failure, shots keeps the frames already produced for debugging. */
  error: z.string().optional(),
});

export type ComparisonReport = z.infer<typeof comparisonReportSchema>;

export const comparisonSchema = z.object({
  id: z.string(),
  itemId: z.string(),
  renderMediaId: z.string().optional(),
  totalScore: z.number(),
  status: comparisonStatusSchema,
  report: comparisonReportSchema,
  createdAt: z.number(),
});

export type Comparison = z.infer<typeof comparisonSchema>;

export const libraryCompareRequestSchema = z
  .object({
    /** Absolute path of the agent render on disk. */
    renderPath: z.string().min(1).max(4096).optional(),
    /** Media id of an already registered / uploaded replica video. */
    renderMediaId: z.string().min(1).max(128).optional(),
  })
  .refine((value) => Boolean(value.renderPath || value.renderMediaId), {
    message: '缺少复刻片：请提供 renderPath 或 renderMediaId',
  });

export type LibraryCompareRequest = z.infer<typeof libraryCompareRequestSchema>;

export const libraryCompareResponseSchema = z.object({
  comparisonId: z.string(),
  status: comparisonStatusSchema,
});

export type LibraryCompareResponse = z.infer<typeof libraryCompareResponseSchema>;

export const libraryComparisonListResponseSchema = z.object({
  comparisons: z.array(comparisonSchema),
});

export type LibraryComparisonListResponse = z.infer<typeof libraryComparisonListResponseSchema>;

export const libraryComparisonResponseSchema = z.object({ comparison: comparisonSchema });

export type LibraryComparisonResponse = z.infer<typeof libraryComparisonResponseSchema>;

// ── Media proxy / generic ok ───────────────────────────────────────────────

/**
 * Query-string schema for GET /api/library/media; domain allowlist and local path allowlist are
 * enforced separately by the daemon.
 * url = remote media (proxied with referer), src = local file under dataDir/media/
 * (thumbnails / diff images).
 */
export const libraryMediaQuerySchema = z
  .object({
    url: z.string().min(1, '缺少媒体地址').max(4096, '媒体地址过长').optional(),
    src: z.string().min(1, '缺少媒体地址').max(4096, '媒体地址过长').optional(),
  })
  .refine((value) => Boolean(value.url || value.src), { message: '缺少媒体地址' });

export type LibraryMediaQuery = z.infer<typeof libraryMediaQuerySchema>;

export const libraryOkResponseSchema = z.object({
  ok: z.literal(true),
  removed: z.number().optional(),
});

export type LibraryOkResponse = z.infer<typeof libraryOkResponseSchema>;
