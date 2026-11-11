/**
 * [INPUT]: Absolute path and duration of the source video, ffmpeg and SQLite.
 * [OUTPUT]: Shot ranges (start/end ms), 3 sample frames per shot, shots table rows and
 *   in-memory shot-analysis job state.
 * [POS]: Library "shot analysis" domain layer; pure ffmpeg scene detection + long-shot
 *   fallback, idempotent rebuild on repeated calls.
 */
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Shot, ShotJob } from '@remixclip/contracts';
import { extractFrame, probeVideo, runFfmpeg } from './ffmpeg.js';
import { mediaLayout, safeSegment } from './media.js';

/** Sample position per shot (relative to the shot range). */
const SAMPLE_POSITIONS = [0.25, 0.5, 0.75] as const;
/** Scene detection threshold: a frame change below it is not a cut point. */
const SCENE_THRESHOLD = 0.3;
/** Fixed segment length for the long-shot / static-frame fallback. */
const FALLBACK_INTERVAL_MS = 4000;
/** Max shots per video; beyond that it degrades to fixed intervals. */
const MAX_SHOTS = 200;
/**
 * Overly short shots are meaningless for frame extraction and scoring, so cuts are spaced
 * at least this far apart.
 */
const MIN_SHOT_MS = 300;

export interface ShotSegment {
  startMs: number;
  endMs: number;
}

interface ShotRow {
  id: string;
  item_id: string;
  index: number;
  start_ms: number;
  end_ms: number;
  thumbnail_path: string | null;
  analysis_json: string | null;
}

function rowToShot(row: ShotRow): Shot {
  let analysis: unknown;
  if (row.analysis_json) {
    try {
      analysis = JSON.parse(row.analysis_json) as unknown;
    } catch {
      analysis = undefined;
    }
  }
  return {
    id: row.id,
    itemId: row.item_id,
    index: row.index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    thumbnailPath: row.thumbnail_path ?? undefined,
    analysis,
  };
}

export function listShots(db: Database.Database, itemId: string): Shot[] {
  const rows = db.prepare(
    'SELECT * FROM shots WHERE item_id = ? ORDER BY "index" ASC',
  ).all(itemId) as ShotRow[];
  return rows.map(rowToShot);
}

/** Scene cuts (ms, ascending, excluding head and tail); ffmpeg's showinfo lines carry pts_time. */
export async function detectSceneCuts(input: string): Promise<number[]> {
  const stderr = await runFfmpeg([
    '-hide_banner',
    '-nostats',
    '-an',
    '-i', input,
    '-filter:v', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    '-f', 'null',
    '-',
  ]);
  const cuts: number[] = [];
  for (const match of stderr.matchAll(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) cuts.push(Math.round(seconds * 1000));
  }
  return Array.from(new Set(cuts)).sort((a, b) => a - b);
}

/**
 * Fixed-interval fallback: even a long shot with an almost static picture must yield
 * verifiable ranges.
 */
function fixedSegments(durationMs: number): ShotSegment[] {
  // Widen the interval past the cap so the segment count stays ≤ MAX_SHOTS.
  const interval = Math.max(FALLBACK_INTERVAL_MS, Math.ceil(durationMs / MAX_SHOTS));
  const segments: ShotSegment[] = [];
  for (let start = 0; start < durationMs && segments.length < MAX_SHOTS; start += interval) {
    segments.push({ startMs: start, endMs: Math.min(start + interval, durationMs) });
  }
  return segments;
}

/** Turn cut points into head-to-tail closed, non-overlapping shot ranges. */
function segmentsFromCuts(cuts: number[], durationMs: number): ShotSegment[] {
  const inner = cuts.filter((cut) => cut >= MIN_SHOT_MS && cut <= durationMs - MIN_SHOT_MS);
  const boundaries = [0];
  for (const cut of inner) {
    if (cut - boundaries[boundaries.length - 1]! >= MIN_SHOT_MS) boundaries.push(cut);
  }
  // Close head and tail: the last shot must reach the end of the video; if the final
  // segment is too short, merge it into the previous one.
  const last = boundaries[boundaries.length - 1]!;
  if (durationMs - last < MIN_SHOT_MS && boundaries.length > 1) boundaries.pop();
  boundaries.push(durationMs);

  const segments: ShotSegment[] = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const startMs = boundaries[i]!;
    const endMs = boundaries[i + 1]!;
    if (endMs > startMs) segments.push({ startMs, endMs });
  }
  return segments;
}

/**
 * Shot planning: use cut points only when there are ≥ 2 usable ones,
 * otherwise (or past the cap) degrade to fixed intervals.
 */
export function planShots(cuts: number[], durationMs: number): ShotSegment[] {
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('无法获取视频时长');
  const usableCuts = cuts.filter((cut) => cut >= MIN_SHOT_MS && cut <= durationMs - MIN_SHOT_MS);
  if (usableCuts.length < 2) return fixedSegments(durationMs);
  const segments = segmentsFromCuts(cuts, durationMs);
  if (segments.length === 0) return fixedSegments(durationMs);
  if (segments.length > MAX_SHOTS) return fixedSegments(durationMs);
  return segments;
}

// ── Background jobs ─────────────────────────────────────────────────────────

interface ShotJobState extends ShotJob {
  status: 'running' | 'ready' | 'failed';
  startedAt: number;
}

/**
 * itemId → job; analyze is mutually exclusive per item, repeated requests reuse
 * the same jobId.
 */
const jobs = new Map<string, ShotJobState>();

export function getShotJob(itemId: string): ShotJob | null {
  const job = jobs.get(itemId);
  if (!job) return null;
  return { jobId: job.jobId, status: job.status, error: job.error };
}

function framesDir(itemId: string): string {
  return path.join(mediaLayout().frames, safeSegment(itemId));
}

/**
 * Clear old frames and rows before rebuilding: a repeated analysis must give consistent
 * results, with no history stacked up.
 */
function resetShots(db: Database.Database, itemId: string): void {
  db.prepare('DELETE FROM shots WHERE item_id = ?').run(itemId);
  const dir = framesDir(itemId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

async function runAnalysis(
  db: Database.Database,
  itemId: string,
  input: string,
  durationMs: number,
  job: ShotJobState,
): Promise<void> {
  resetShots(db, itemId);
  const dir = framesDir(itemId);

  const cuts = await detectSceneCuts(input);
  const segments = planShots(cuts, durationMs);

  const insert = db.prepare(
    `INSERT INTO shots (id, item_id, "index", start_ms, end_ms, thumbnail_path, analysis_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );

  for (const [index, segment] of segments.entries()) {
    const frames: string[] = [];
    for (const [k, position] of SAMPLE_POSITIONS.entries()) {
      const atMs = Math.round(segment.startMs + (segment.endMs - segment.startMs) * position);
      const output = path.join(dir, `${index}-${k}.jpg`);
      await extractFrame({
        input,
        atMs,
        output,
        filter: 'scale=360:-2',
        quality: 4,
      });
      frames.push(output);
    }
    // The 50% frame serves as the thumbnail, matching the sample point used for comparison.
    insert.run(`shot_${randomUUID()}`, itemId, index, segment.startMs, segment.endMs, frames[1] ?? null);
  }

  job.status = 'ready';
}

/**
 * Start shot analysis: return the same job if this item is already running, otherwise
 * create one and run it asynchronously.
 * Duration prefers the already-probed metadata, probing with ffprobe on the spot when missing.
 */
export function startShotAnalysis(
  db: Database.Database,
  itemId: string,
  sourcePath: string,
  knownDurationMs?: number,
): ShotJob {
  const running = jobs.get(itemId);
  if (running?.status === 'running') return getShotJob(itemId)!;

  const job: ShotJobState = { jobId: `ana_${randomUUID()}`, status: 'running', startedAt: Date.now() };
  jobs.set(itemId, job);

  void (async () => {
    try {
      const durationMs = knownDurationMs && knownDurationMs > 0
        ? knownDurationMs
        : (await probeVideo(sourcePath)).durationMs;
      if (!durationMs) throw new Error('无法获取视频时长，拉片失败');
      await runAnalysis(db, itemId, sourcePath, durationMs, job);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : '拉片失败';
    }
  })();

  return getShotJob(itemId)!;
}
