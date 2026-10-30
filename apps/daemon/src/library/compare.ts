/**
 * [INPUT]: Item source video, render (local path or media_files row), shots table, plus
 *   ffmpeg / pngjs / pixelmatch.
 * [OUTPUT]: comparisons rows, per-shot score and verdict, source frame / render frame /
 *   diff image paths.
 * [POS]: Library "pixel verification" domain layer; alignment (proportional scale + letterbox),
 *   scoring, the serial queue and result retention all live here.
 */
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type {
  Comparison,
  ComparisonFrame,
  ComparisonReport,
  ComparisonShot,
  ComparisonShotStatus,
  ComparisonStatus,
  MediaFile,
} from '@remixclip/contracts';
import type { VideoMeta } from './ffmpeg.js';
import { extractFrame, probeVideo } from './ffmpeg.js';
import { findSourceMedia, getMediaFile, mediaLayout, registerLocalMedia } from './media.js';
import { detectSceneCuts, listShots, planShots } from './shots.js';

/**
 * Unified scale height for both sides; width is derived from the source ratio, then
 * letterboxed.
 */
const TARGET_HEIGHT = 480;
/** Sample positions stay consistent with shot-analysis frame extraction. */
const SAMPLE_POSITIONS = [0.25, 0.5, 0.75] as const;
const MATCH_THRESHOLD = 0.98;
const MINOR_THRESHOLD = 0.9;
/**
 * A shot-count difference beyond this ratio flags the whole comparison as structurally
 * inconsistent.
 */
const STRUCTURE_TOLERANCE = 0.2;
/** Keep only the latest N comparisons per item (including their diff image directories). */
const MAX_COMPARISONS_PER_ITEM = 20;

// ── Record read / write ─────────────────────────────────────────────────────

interface ComparisonRow {
  id: string;
  item_id: string;
  render_media_id: string | null;
  total_score: number;
  status: string;
  report_json: string;
  created_at: number;
}

function rowToComparison(row: ComparisonRow): Comparison {
  let report: ComparisonReport;
  try {
    report = JSON.parse(row.report_json) as ComparisonReport;
  } catch {
    report = { shots: [], sourceShotCount: 0, renderShotCount: 0 };
  }
  return {
    id: row.id,
    itemId: row.item_id,
    renderMediaId: row.render_media_id ?? undefined,
    totalScore: row.total_score,
    status: row.status as ComparisonStatus,
    report,
    createdAt: row.created_at,
  };
}

export function listComparisons(db: Database.Database, itemId: string): Comparison[] {
  const rows = db.prepare(
    'SELECT * FROM comparisons WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as ComparisonRow[];
  return rows.map(rowToComparison);
}

export function getComparison(db: Database.Database, id: string): Comparison | null {
  const row = db.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as ComparisonRow | undefined;
  return row ? rowToComparison(row) : null;
}

function saveComparison(
  db: Database.Database,
  id: string,
  patch: { totalScore: number; status: ComparisonStatus; report: ComparisonReport },
): void {
  db.prepare('UPDATE comparisons SET total_score = ?, status = ?, report_json = ? WHERE id = ?')
    .run(patch.totalScore, patch.status, JSON.stringify(patch.report), id);
}

/**
 * Delete comparisons beyond the retention cap along with their diff directories, so disk
 * use does not grow unbounded.
 */
function pruneComparisons(db: Database.Database, itemId: string): void {
  const rows = db.prepare(
    'SELECT id FROM comparisons WHERE item_id = ? ORDER BY created_at DESC',
  ).all(itemId) as { id: string }[];
  const { diffs } = mediaLayout();
  for (const row of rows.slice(MAX_COMPARISONS_PER_ITEM)) {
    rmSync(path.join(diffs, row.id), { recursive: true, force: true });
    db.prepare('DELETE FROM comparisons WHERE id = ?').run(row.id);
  }
}

// ── Alignment and scoring ───────────────────────────────────────────────────

function classify(score: number): ComparisonShotStatus {
  if (score >= MATCH_THRESHOLD) return 'match';
  if (score >= MINOR_THRESHOLD) return 'minor';
  return 'mismatch';
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Target size = the source scaled proportionally to height 480 (even width, matching
 * ffmpeg scale=-2). Both sides letterbox to the same size, so pixels correspond one-to-one.
 */
function targetSize(meta: VideoMeta): { width: number; height: number } {
  if (!meta.width || !meta.height) throw new Error('无法读取原片宽高');
  const width = Math.max(2, 2 * Math.round((meta.width * TARGET_HEIGHT) / meta.height / 2));
  return { width, height: TARGET_HEIGHT };
}

function alignFilter(width: number, height: number): string {
  return `scale=-2:${height},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`;
}

interface SampleInput {
  sourcePath: string;
  renderPath: string;
  sourceAtMs: number;
  renderAtMs: number;
  filter: string;
  width: number;
  height: number;
  dir: string;
  shotIndex: number;
  position: number;
}

/**
 * Extract both sides' frames at the same timestamp → strict / perceptual pixelmatch passes
 * → write one diff image.
 */
async function compareSample(input: SampleInput): Promise<ComparisonFrame> {
  const sourceOut = path.join(input.dir, `source-${input.shotIndex}-${input.position}.png`);
  const renderOut = path.join(input.dir, `render-${input.shotIndex}-${input.position}.png`);
  const diffOut = path.join(input.dir, `diff-${input.shotIndex}-${input.position}.png`);

  await extractFrame({
    input: input.sourcePath,
    atMs: input.sourceAtMs,
    output: sourceOut,
    filter: input.filter,
  });
  await extractFrame({
    input: input.renderPath,
    atMs: input.renderAtMs,
    output: renderOut,
    filter: input.filter,
  });

  const source = PNG.sync.read(readFileSync(sourceOut));
  const render = PNG.sync.read(readFileSync(renderOut));
  if (source.width !== input.width || source.height !== input.height
    || render.width !== input.width || render.height !== input.height) {
    throw new Error('采样帧尺寸与目标尺寸不一致，对齐失败');
  }

  const totalPixels = input.width * input.height;
  const exactDiffPixels = pixelmatch(source.data, render.data, undefined, input.width, input.height, {
    includeAA: true,
    threshold: 0,
  });
  const diffBuffer = new Uint8Array(totalPixels * 4);
  const perceptualDiffPixels = pixelmatch(source.data, render.data, diffBuffer, input.width, input.height, {
    includeAA: false,
    threshold: 0.1,
  });
  const diffPng = new PNG({ width: input.width, height: input.height });
  diffPng.data = Buffer.from(diffBuffer);
  writeFileSync(diffOut, PNG.sync.write(diffPng));

  return {
    atMs: input.sourceAtMs,
    score: round6(1 - perceptualDiffPixels / totalPixels),
    perceptualRatio: round6(perceptualDiffPixels / totalPixels),
    exactRatio: round6(exactDiffPixels / totalPixels),
    sourcePath: sourceOut,
    renderPath: renderOut,
    diffPath: diffOut,
  };
}

/**
 * Render shot count: run the same detector once; if it fails, estimate from the duration
 * ratio rather than failing the whole comparison.
 */
async function countRenderShots(
  renderPath: string,
  renderDurationMs: number,
  sourceShotCount: number,
  sourceDurationMs: number,
): Promise<number> {
  try {
    const cuts = await detectSceneCuts(renderPath);
    return planShots(cuts, renderDurationMs).length;
  } catch {
    if (sourceDurationMs <= 0) return sourceShotCount;
    return Math.max(1, Math.round((sourceShotCount * renderDurationMs) / sourceDurationMs));
  }
}

// ── Job orchestration ───────────────────────────────────────────────────────

/** itemId → running comparisonId: comparisons are mutually exclusive per item. */
const activeByItem = new Map<string, string>();
/** CPU-heavy tasks run serially (in-process concurrency 1, no forked workers). */
let chain: Promise<void> = Promise.resolve();

export function getActiveComparison(itemId: string): string | null {
  return activeByItem.get(itemId) ?? null;
}

async function runComparison(
  db: Database.Database,
  comparisonId: string,
  itemId: string,
  source: MediaFile,
  render: MediaFile,
): Promise<void> {
  const report: ComparisonReport = {
    shots: [],
    sourceShotCount: 0,
    renderShotCount: 0,
  };
  const dir = path.join(mediaLayout().diffs, comparisonId);
  mkdirSync(dir, { recursive: true });

  try {
    const shots = listShots(db, itemId);
    if (shots.length === 0) throw new Error('还没有分镜结果，请先拉片');
    report.sourceShotCount = shots.length;

    // Re-probe on comparison: probing may have failed during download, so row metadata
    // cannot be fully trusted.
    const probedSource = await probeVideo(source.path);
    const probedRender = await probeVideo(render.path);
    const sourceMeta: VideoMeta = {
      durationMs: probedSource.durationMs ?? source.durationMs,
      width: probedSource.width ?? source.width,
      height: probedSource.height ?? source.height,
    };
    const sourceDurationMs = sourceMeta.durationMs ?? 0;
    const renderDurationMs = probedRender.durationMs ?? render.durationMs ?? 0;
    if (!sourceDurationMs || !renderDurationMs) throw new Error('无法获取视频时长');

    const { width, height } = targetSize(sourceMeta);
    report.width = width;
    report.height = height;

    const renderShotCount = await countRenderShots(
      render.path,
      renderDurationMs,
      shots.length,
      sourceDurationMs,
    );
    report.renderShotCount = renderShotCount;

    const filter = alignFilter(width, height);
    const pairCount = Math.min(shots.length, renderShotCount);
    // Map sample points by ratio when durations differ; the ratio is always 1 for the
    // same clip.
    const durationRatio = renderDurationMs / sourceDurationMs;

    for (const shot of shots.slice(0, pairCount)) {
      const frames: ComparisonFrame[] = [];
      for (const [position, ratio] of SAMPLE_POSITIONS.entries()) {
        const sourceAtMs = Math.round(shot.startMs + (shot.endMs - shot.startMs) * ratio);
        const renderAtMs = Math.min(
          Math.max(0, Math.round(sourceAtMs * durationRatio)),
          Math.max(0, renderDurationMs - 1),
        );
        const frame = await compareSample({
          sourcePath: source.path,
          renderPath: render.path,
          sourceAtMs,
          renderAtMs,
          filter,
          width,
          height,
          dir,
          shotIndex: shot.index,
          position,
        });
        frames.push(frame);
      }
      const score = round6(frames.reduce((sum, frame) => sum + frame.score, 0) / frames.length);
      report.shots.push({
        index: shot.index,
        startMs: shot.startMs,
        endMs: shot.endMs,
        score,
        status: classify(score),
        frames,
      });
    }

    const totalScore = round6(
      report.shots.reduce((sum, shot) => sum + shot.score, 0) / Math.max(1, report.shots.length),
    );
    const structureMismatch = report.sourceShotCount > 0
      && Math.abs(renderShotCount - report.sourceShotCount) / report.sourceShotCount > STRUCTURE_TOLERANCE;
    const status: ComparisonStatus = structureMismatch ? 'structure-mismatch' : classify(totalScore);
    saveComparison(db, comparisonId, { totalScore, status, report });
  } catch (error) {
    // Do not write a score on failure: status=failed + keep produced frames, to tell
    // alignment issues from render issues.
    report.error = error instanceof Error ? error.message : '比对失败';
    saveComparison(db, comparisonId, { totalScore: 0, status: 'failed', report });
  } finally {
    activeByItem.delete(itemId);
    pruneComparisons(db, itemId);
  }
}

function enqueue(task: () => Promise<void>): void {
  chain = chain.then(task).catch(() => undefined);
}

export interface StartComparisonInput {
  renderPath?: string;
  renderMediaId?: string;
}

/**
 * Start a comparison: precondition checks throw synchronously (route replies 400/404),
 * then persist a running row and enqueue; reuse the running job if the item already has one.
 */
export function startComparison(
  db: Database.Database,
  itemId: string,
  input: StartComparisonInput,
): { comparisonId: string; status: ComparisonStatus } {
  const running = activeByItem.get(itemId);
  if (running) return { comparisonId: running, status: 'running' };

  const source = findSourceMedia(db, itemId);
  if (!source) throw new Error('还没有本地原片，请先下载视频');
  if (listShots(db, itemId).length === 0) throw new Error('还没有分镜结果，请先拉片');

  let render: MediaFile;
  if (input.renderMediaId) {
    const media = getMediaFile(db, input.renderMediaId);
    if (!media) throw new Error('复刻片记录不存在');
    if (!existsSync(media.path)) throw new Error('复刻片文件已被删除');
    render = media;
  } else if (input.renderPath) {
    if (!existsSync(input.renderPath)) throw new Error('复刻片路径不存在');
    render = registerLocalMedia(db, itemId, input.renderPath, 'render');
  } else {
    throw new Error('缺少复刻片：请提供 renderPath 或 renderMediaId');
  }

  const comparisonId = `cmp_${randomUUID()}`;
  const report: ComparisonReport = { shots: [], sourceShotCount: 0, renderShotCount: 0 };
  db.prepare(
    `INSERT INTO comparisons (id, item_id, render_media_id, total_score, status, report_json, created_at)
     VALUES (?, ?, ?, 0, 'running', ?, ?)`,
  ).run(comparisonId, itemId, render.id, JSON.stringify(report), Date.now());

  activeByItem.set(itemId, comparisonId);
  enqueue(() => runComparison(db, comparisonId, itemId, source, render));
  return { comparisonId, status: 'running' };
}
