/**
 * How to write the numbers on the tool row / shell header.
 *
 * One hard rule (learned the hard way: the UI once showed "0.0s"): **if you don't have it, don't
 * show it — no estimating, no making numbers up**.
 * codex's `tool_use` is only emitted at `item.completed`, arriving together with `tool_result`,
 * so the computed elapsed time is 0 —— that's not "it ran fast", that's "we don't know"
 * (spec §2.2b / W10).
 */

/** The delta computed when call and result arrive in the same batch; not a real elapsed time */
export const UNKNOWN_ELAPSED_BELOW_MS = 100;

/** Tool row, task step: 0.4s / 18.2s / 1m 12s */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms == null || !(ms >= 0)) return null;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Elapsed time on the execution-record header: one notch coarser than the tool row —— 31s / 1m 12s;
 * one decimal within 10s; anything under 1s counts as unknown (don't show "0s" the instant the
 * shell first appears).
 */
export function formatShellElapsed(ms: number | null | undefined): string | null {
  if (ms == null || !(ms >= 1000)) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * The token estimate on the thinking row: `950` / `1k` / `3.3k`.
 *
 * The threshold sits at **1000**, consistent with the other three k-abbreviations in this repo:
 * only a full thousand gets abbreviated, `950` is written out as-is.
 * Abbreviation **rounds** (`3278` → `3.3k`), it does not truncate —— `ChatPane`'s
 * `compactCount` uses `Math.floor`, so the same number would be written as `3.2k`, and being off
 * by one digit reads like it thought less.
 *
 * **There is deliberately no M tier.** This number is the cumulative estimate for a **single
 * thinking block**, capped by the model's thinking budget (claude maxes out around 64k), so the
 * millions are never reachable —— writing a branch that can't be reached is dead code, and dead
 * code makes the next person think it was verified.
 *
 * Why not reuse the three existing ones: `compactCount` (`ChatPane.tsx`) truncates and has no
 * finiteness guard; `formatStars` / `formatDiscordPresenceCount` are mathematically right, but one
 * lives in a GitHub star hook and the other in a Discord online-count hook — neither the name nor
 * the ownership fits this. How numbers on the execution record are written has exactly one source,
 * this file (`formatElapsed` / `formatShellElapsed` both live here), so a new one should land in
 * the same place instead of borrowing a name from another domain.
 *
 * Returns `null` when unavailable, same as the hard rule at the top of this file: no estimating,
 * no making numbers up.
 */
export function formatThinkingTokens(count: number | null | undefined): string | null {
  if (count == null || !Number.isFinite(count) || count <= 0) return null;
  if (count < 1000) return String(Math.round(count));
  return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`;
}

/** A separate notation for audio artifacts (component 24): minutes unpadded, seconds two-digit */
export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Decides the artifact card shape: only html has "publish" (D28) */
export type ArtifactKind = 'html' | 'image' | 'video' | 'audio' | 'doc';

export function artifactKind(path: string): ArtifactKind {
  const p = String(path ?? '').toLowerCase();
  if (/\.html?$/.test(p)) return 'html';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(p)) return 'image';
  if (/\.(mp4|webm|mov)$/.test(p)) return 'video';
  if (/\.(mp3|wav|m4a|ogg)$/.test(p)) return 'audio';
  return 'doc';
}

/**
 * Criterion for a primary artifact (same suffixes the daemon's `primaryArtifactChangeForRun`
 * accepts); md / csv are not primary artifacts
 */
export function isArtifactPath(path: string): boolean {
  return artifactKind(path) !== 'doc';
}

export interface DiffStat { added: number; removed: number }

/** Only non-negative integers count: NaN / negatives / strings all count as not given */
function countedLines(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Change size: most agents put the raw material in the input (Write's `content`, Edit's old/new
 * strings), so we count the lines ourselves.
 * If we can't count it, return null —— that row then shows elapsed time instead of `+0 -0`.
 *
 * The exception is codex: its app-server wire carries patches right next to file changes, and a big
 * patch is 20k+ characters, which stuffed into the event stream would blow up the on-disk size of
 * every message. So the daemon counts it on the spot in `runtimes/json-event-stream.ts`, drops the
 * patch, and puts only the two numbers into `od_diff_stat`. This function honors that field; the
 * algorithm is the same one as the two branches below (see the comments over there), not a second
 * counting convention. If present it takes precedence: an agent that already counted is more
 * accurate than counting again here from a partial input.
 */
export function diffStat(toolName: string, input: unknown): DiffStat | null {
  const name = String(toolName ?? '').toLowerCase();
  const rec = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const carried = rec.od_diff_stat;
  if (carried && typeof carried === 'object') {
    const added = countedLines((carried as Record<string, unknown>).added);
    const removed = countedLines((carried as Record<string, unknown>).removed);
    if (added != null && removed != null) return { added, removed };
    return null;
  }
  if ((name === 'write' || name === 'write_file') && typeof rec.content === 'string') {
    return { added: rec.content.split('\n').length, removed: 0 };
  }
  if (name === 'edit' && typeof rec.old_string === 'string') {
    const next = typeof rec.new_string === 'string' ? rec.new_string : '';
    return { added: next.split('\n').length, removed: rec.old_string.split('\n').length };
  }
  return null;
}

export const basename = (p: string): string =>
  String(p ?? '').replace(/^['"]|['"]$/g, '').split(/[\\/]/).pop() ?? '';

/**
 * Elision for long file names —— **the extension is always visible**, what gets elided is the stem.
 *
 * That line in cell 4 of the design spec was already truncated in the source file:
 * `settings-membership-center-product-card-alignment-round-3-f….png` (the Chinese original was
 * 43 chars → 28 chars, extension intact).
 * That sets the budget at 28: extension 4 + ellipsis 1 + stem 23.
 *
 * Why not rely on CSS `text-overflow`: the file name is nested in `<button><code>`, which is
 * **a single atomic block** as far as flex shrinking goes —— either the whole block fits, or the
 * whole block is pushed out by the ellipsis, so the row ends up with just a "…", the extension is
 * gone, and the elapsed time on the same row gets pushed to the end of the line. Cutting the
 * string is what cuts accurately.
 *
 * Nor measure by pixels: measuring width requires reading layout, jitters with font and container,
 * and can't be tested in a pure function. A character budget is deterministic, and matching that
 * one spec line is enough.
 */
export function elideFileName(name: string, max = 28): string {
  const raw = String(name ?? '');
  if (raw.length <= max) return raw;
  // A leading dot is part of a hidden file, not an extension separator (`.gitignore` is all stem)
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot) : '';
  // When the extension itself is absurdly long (most likely not an extension at all), give it no
  // room, otherwise the stem gets squeezed to zero
  const keepExt = ext.length > 0 && ext.length <= 8 ? ext : '';
  const head = Math.max(1, max - keepExt.length - 1);
  return `${raw.slice(0, head)}…${keepExt}`;
}
