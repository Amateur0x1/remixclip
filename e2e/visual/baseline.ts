/**
 * [INPUT]: PNG buffer from a Playwright screenshot and the e2e/baselines/<name>.png baseline.
 * [OUTPUT]: pixelmatch per-pixel comparison result; on failure the actual image and the
 *   diff image are written to .artifacts/.
 * [POS]: The verdict layer of visual regression; baselines are committed, the
 *   actual/diff artifacts are not.
 *
 * Usage:
 *   pnpm visual          Compare (records automatically when the baseline is missing)
 *   pnpm visual:record   Force re-record baselines (VISUAL_UPDATE=1)
 *   VISUAL_MAX_DIFF_PIXELS=40 pnpm visual   Loosen tolerance across machines
 *                                           (different fonts / antialiasing)
 *   VISUAL_COLOR_THRESHOLD=0 pnpm visual    Byte-for-byte identical (for debugging)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const E2E_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const BASELINE_DIR = path.join(E2E_ROOT, 'baselines');
export const ARTIFACT_DIR = path.join(E2E_ROOT, '.artifacts');

/**
 * Per-pixel color difference threshold. Defaults such as 0.1/0.2 treat a near-white
 * skeleton screen and a white background as "identical" (measured: 12 cards turning
 * into 6 still yields 0 diff), so UI regression must be sensitive enough:
 * 0.01 = a difference visible to the naked eye.
 */
const COLOR_THRESHOLD = Number(process.env.VISUAL_COLOR_THRESHOLD ?? 0.01);

export interface VisualResult {
  ok: boolean;
  message: string;
  diffPixels?: number;
}

export function compareWithBaseline(name: string, actualPng: Buffer): VisualResult {
  const actualPath = writeArtifact('actual', name, actualPng);
  const baselinePath = path.join(BASELINE_DIR, `${name}.png`);
  const recording = process.env.VISUAL_UPDATE === '1';

  if (recording || !existsSync(baselinePath)) {
    mkdirSync(BASELINE_DIR, { recursive: true });
    writeFileSync(baselinePath, actualPng);
    return {
      ok: true,
      message: `${recording ? '已重录' : '首次录制'}基线：${path.relative(E2E_ROOT, baselinePath)}`,
    };
  }

  const baseline = PNG.sync.read(readFileSync(baselinePath));
  const actual = PNG.sync.read(actualPng);
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      ok: false,
      message: `截图尺寸变化：基线 ${baseline.width}x${baseline.height} → 实际 ${actual.width}x${actual.height}`,
    };
  }

  const diff = new PNG({ width: baseline.width, height: baseline.height });
  const diffPixels = pixelmatch(
    baseline.data,
    actual.data,
    diff.data,
    baseline.width,
    baseline.height,
    { threshold: COLOR_THRESHOLD },
  );

  // Rendering is almost fully deterministic on the same machine, but a pixel or two of
  // font/image-decode jitter remains, so allow a 10-pixel noise budget; a real regression
  // costs thousands of pixels (skeleton 12→6 cards = 208311).
  const maxDiffPixels = Number(process.env.VISUAL_MAX_DIFF_PIXELS ?? 10);
  if (diffPixels <= maxDiffPixels) {
    return {
      ok: true,
      message: `与基线一致（${diffPixels} 个差异像素，阈值 ${maxDiffPixels}）`,
      diffPixels,
    };
  }

  const diffPath = writeArtifact('diff', `${name}.diff`, PNG.sync.write(diff));
  return {
    ok: false,
    message: [
      `视觉回归：${diffPixels} 个像素不同（阈值 ${maxDiffPixels}）`,
      `diff: ${path.relative(E2E_ROOT, diffPath)}`,
      `actual: ${path.relative(E2E_ROOT, actualPath)}`,
      '确认改动符合预期后运行 pnpm visual:record 重录基线',
    ].join('\n'),
    diffPixels,
  };
}

function writeArtifact(kind: 'actual' | 'diff', name: string, png: Buffer): string {
  const dir = path.join(ARTIFACT_DIR, kind);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${name}.png`);
  writeFileSync(target, png);
  return target;
}
