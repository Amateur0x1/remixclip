#!/usr/bin/env node
/**
 * [INPUT]: local ffmpeg/ffprobe, apps/daemon/dist (run pnpm --filter @remixclip/daemon run build
 *           first) and a temporary dataDir; by default pulls a public sample clip (media.w3.org's
 *           Sintel trailer), overridable via REMIXCLIP_SAMPLE_VIDEO=<local path or URL>.
 * [OUTPUT]: real output of the full download → analyze → compare chain, plus two assertions:
 *           "self-compare of the source ≥ 0.98" and "50% downscale drops the score markedly".
 * [POS]: Re-runnable acceptance script for the library pipeline (not shipped); run with
 *         `node scripts/library-pipeline-check.mjs`.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const daemonDir = path.resolve(here, '..');
const keep = process.argv.includes('--keep');
/** Public sample clip: 52s of real 854×480 footage, enough to verify scene segmentation and pixel comparison. */
const PUBLIC_SAMPLE_URL = 'https://media.w3.org/2010/05/sintel/trailer.mp4';
/** Capture 24s of the real sample (still satisfies the ≥20s requirement); skip the trailer's slow opening
 *  and take the section with richer visual detail. */
const TRIM_FROM_SECONDS = 16;
const TRIM_TO_SECONDS = 24;

const root = mkdtempSync(path.join(tmpdir(), 'remixclip-pipeline-'));
const dataDir = path.join(root, 'data');
const workDir = path.join(root, 'media');
mkdirSync(dataDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

function log(title, value) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const mod = require('@ffmpeg-installer/ffmpeg');
    if (mod?.path && existsSync(mod.path)) return mod.path;
  } catch {
    // Fall back to PATH.
  }
  return 'ffmpeg';
}

function ffprobePath() {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  try {
    const mod = require('@ffprobe-installer/ffprobe');
    if (mod?.path && existsSync(mod.path)) return mod.path;
  } catch {
    // Fall back to PATH.
  }
  return 'ffprobe';
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

const ffmpeg = ffmpegPath();
const ffprobe = ffprobePath();

/** One ffprobe call yields the duration and dimensions needed for acceptance (metadata assertions rely on it). */
async function probe(file) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  const data = JSON.parse(stdout);
  const video = (data.streams ?? []).find((stream) => stream.codec_type === 'video');
  return {
    durationMs: Math.round(Number(data.format?.duration ?? video?.duration ?? 0) * 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
  };
}

async function downloadFile(url, dest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  } finally {
    clearTimeout(timeout);
  }
}

/** Fallback when the network is unavailable: 20s of four clearly distinct scenes so scene detection
 *  produces multiple shots. */
async function makeSyntheticSource(source) {
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'smptebars=size=720x1280:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'rgbtestsrc=size=720x1280:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30:duration=5',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]',
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', source,
  ]);
}

/**
 * Prepare acceptance media: prefer the public real sample (REMIXCLIP_SAMPLE_VIDEO can override it with a
 * local file / another URL); anything over 24s is trimmed to the first 24s; then generate a 50%-scaled
 * render clip.
 */
async function makeFixtures() {
  const source = path.join(workDir, 'source.mp4');
  const scaled = path.join(workDir, 'scaled.mp4');
  const explicit = process.env.REMIXCLIP_SAMPLE_VIDEO;
  let origin = PUBLIC_SAMPLE_URL;

  try {
    if (explicit && existsSync(explicit)) {
      copyFileSync(explicit, source);
      origin = `本地文件 ${explicit}`;
    } else if (explicit) {
      await downloadFile(explicit, source);
      origin = explicit;
    } else {
      await downloadFile(PUBLIC_SAMPLE_URL, source);
    }
  } catch (error) {
    console.warn(`⚠ 公开样片不可用（${error instanceof Error ? error.message : String(error)}），改用合成测试片`);
    rmSync(source, { force: true });
  }

  if (!existsSync(source)) {
    await makeSyntheticSource(source);
    origin = 'ffmpeg 合成测试片';
  }

  const original = await probe(source);
  if (original.durationMs > TRIM_TO_SECONDS * 1000 + 2_000) {
    const trimmed = path.join(workDir, 'source-trim.mp4');
    await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(TRIM_FROM_SECONDS), '-t', String(TRIM_TO_SECONDS), '-i', source,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', trimmed,
    ]);
    rmSync(source, { force: true });
    copyFileSync(trimmed, source);
  }

  // 50% downscale + low-bitrate re-encode (simulates half-resolution delivery): score should be clearly below
  // the source self-compare.
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source, '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '40', '-pix_fmt', 'yuv420p', '-an', scaled,
  ]);

  const meta = await probe(source);
  return { source, scaled, meta, origin };
}

/** Static file server: simulates a social-media CDN (also records whether requests carry a Referer). */
function startStaticServer(dir) {
  const seen = [];
  const server = createServer((req, res) => {
    const file = path.join(dir, path.basename(decodeURIComponent(req.url.split('?')[0])));
    seen.push({ url: req.url, referer: req.headers.referer ?? '', range: Boolean(req.headers.range) });
    if (!existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function freePort(start) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(freePort(start + 1)));
    probe.listen(start, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function main() {
  log('运行环境', { node: process.version, ffmpeg, ffprobe, root });
  const { source, scaled, meta, origin } = await makeFixtures();
  log('验收素材', { origin, durationMs: meta.durationMs, width: meta.width, height: meta.height });
  if (meta.durationMs < 20_000) throw new Error(`验收素材不足 20s：${meta.durationMs}ms`);
  const statics = await startStaticServer(workDir);
  const port = await freePort(7901);
  const base = `http://127.0.0.1:${port}`;

  const daemon = spawn(
    process.execPath,
    [path.join(daemonDir, 'dist', 'cli.js'), '--port', String(port), '--data-dir', dataDir],
    {
      cwd: daemonDir,
      env: { ...process.env, REMIXCLIP_MEDIA_HOSTS: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  daemon.stdout.on('data', (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  daemon.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`));

  const api = async (method, url, body, raw) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: raw
        ? { 'content-type': raw.type, 'content-length': String(raw.size) }
        : body
          ? { 'content-type': 'application/json' }
          : undefined,
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url} → ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`${base}/api/library/ping`)).ok;
      } catch {
        return false;
      }
    }, 15_000, 'daemon 启动');

    const videoUrl = `http://127.0.0.1:${statics.port}/source.mp4`;
    await api('POST', '/api/library/import', {
      platform: 'bilibili',
      notes: [{
        note_id: 'BV1pipeline',
        title: '分镜测试片',
        video: {
          video_url: videoUrl,
          duration: Math.round(meta.durationMs / 1000),
          width: meta.width,
          height: meta.height,
        },
      }],
    });
    const itemId = 'bilibili:BV1pipeline';
    const itemPath = encodeURIComponent(itemId);

    // ── Stage 1: download ──────────────────────────────────────────────────
    const started = await api('POST', `/api/library/items/${itemPath}/download`);
    log('POST /download', { status: started.media.status, path: started.media.path });
    const media = await waitFor(async () => {
      const list = (await api('GET', `/api/library/items/${itemPath}/media`)).media;
      const source = list.find((entry) => entry.kind === 'source');
      return source && source.status !== 'pending' && source.status !== 'downloading' ? source : null;
    }, 30_000, '视频下载完成');
    log('GET /media', media);
    if (media.status !== 'ready') throw new Error(`下载失败：${media.error}`);
    if (!media.durationMs || Math.abs(media.durationMs - meta.durationMs) > 700) {
      throw new Error(`ffprobe 时长不正确：${media.durationMs}（期望 ${meta.durationMs}）`);
    }
    if (media.width !== meta.width || media.height !== meta.height) {
      throw new Error(`ffprobe 宽高不正确：${media.width}×${media.height}（期望 ${meta.width}×${meta.height}）`);
    }
    if (!statics.seen.some((entry) => entry.referer.length > 0)) throw new Error('下载请求没有带 Referer');

    // ── Stage 2: shot breakdown ──────────────────────────────────────────
    const job = await api('POST', `/api/library/items/${itemPath}/analyze`);
    log('POST /analyze', job);
    const shotsResult = await waitFor(async () => {
      const result = await api('GET', `/api/library/items/${itemPath}/shots`);
      if (result.job?.status === 'failed') throw new Error(`拉片失败：${result.job.error}`);
      return result.job?.status === 'ready' ? result : null;
    }, 300_000, '拉片完成');
    log('GET /shots', {
      count: shotsResult.shots.length,
      shots: shotsResult.shots.map((shot) => ({ index: shot.index, startMs: shot.startMs, endMs: shot.endMs })),
    });
    if (shotsResult.shots.length < 2) throw new Error('镜头数少于 2');
    if (shotsResult.shots[0].startMs !== 0) throw new Error('第一个镜头没有从 0 开始');
    if (shotsResult.shots.at(-1).endMs !== media.durationMs) throw new Error('最后一个镜头没有闭合到视频结束');
    for (let i = 1; i < shotsResult.shots.length; i += 1) {
      if (shotsResult.shots[i].startMs !== shotsResult.shots[i - 1].endMs) {
        throw new Error(`镜头 ${i} 与前一个镜头不连续或重叠`);
      }
    }
    const thumbnail = shotsResult.shots[1].thumbnailPath;
    const thumbResponse = await fetch(`${base}/api/library/media?src=${encodeURIComponent(thumbnail)}`);
    if (!thumbResponse.ok) throw new Error(`缩略图不可访问：${thumbResponse.status}`);
    log('缩略图', { path: thumbnail, bytes: (await thumbResponse.arrayBuffer()).byteLength });

    // ── Stage 3: pixel check (source vs source) ────────────────────────
    const selfCompare = await api('POST', `/api/library/items/${itemPath}/compare`, { renderPath: source });
    const selfResult = await waitFor(async () => {
      const { comparison } = await api('GET', `/api/library/comparisons/${selfCompare.comparisonId}`);
      return comparison.status === 'running' ? null : comparison;
    }, 300_000, '原片自比完成');
    log('原片 vs 原片', {
      status: selfResult.status,
      totalScore: selfResult.totalScore,
      shots: selfResult.report.shots.map((shot) => ({ index: shot.index, score: shot.score, status: shot.status })),
      width: selfResult.report.width,
      height: selfResult.report.height,
    });
    if (selfResult.status !== 'match' || selfResult.totalScore < 0.98) {
      throw new Error(`护栏失败：原片自比总分 ${selfResult.totalScore} 未达 0.98`);
    }
    if (selfResult.report.shots.some((shot) => shot.status !== 'match')) {
      throw new Error('护栏失败：存在非 match 的镜头');
    }

    // ── Stage 3: 50%-scaled render clip (via upload → renderMediaId) ──
    const upload = await fetch(
      `${base}/api/library/items/${itemPath}/renders?filename=scaled.mp4`,
      { method: 'POST', headers: { 'content-type': 'video/mp4' }, body: readFileSync(scaled) },
    );
    if (!upload.ok) throw new Error(`上传复刻片失败：${upload.status} ${await upload.text()}`);
    const uploaded = (await upload.json()).media;
    log('POST /renders', { id: uploaded.id, bytes: uploaded.bytes, durationMs: uploaded.durationMs });

    const scaledCompare = await api('POST', `/api/library/items/${itemPath}/compare`, {
      renderMediaId: uploaded.id,
    });
    const scaledResult = await waitFor(async () => {
      const { comparison } = await api('GET', `/api/library/comparisons/${scaledCompare.comparisonId}`);
      return comparison.status === 'running' ? null : comparison;
    }, 300_000, '缩放片比对完成');
    log('原片 vs 半分辨率复刻片', {
      status: scaledResult.status,
      totalScore: scaledResult.totalScore,
      shots: scaledResult.report.shots.map((shot) => ({
        index: shot.index,
        score: shot.score,
        status: shot.status,
        perceptualRatio: shot.frames[0].perceptualRatio,
        exactRatio: shot.frames[0].exactRatio,
      })),
    });
    const diffPath = scaledResult.report.shots[0]?.frames[0]?.diffPath;
    const diffResponse = await fetch(`${base}/api/library/media?src=${encodeURIComponent(diffPath)}`);
    if (!diffResponse.ok) throw new Error(`diff 图不可访问：${diffResponse.status}`);
    log('diff 图', { path: diffPath, bytes: (await diffResponse.arrayBuffer()).byteLength });
    if (scaledResult.totalScore >= 0.98) {
      throw new Error(`缩放片不应达到 match：${scaledResult.totalScore}`);
    }
    if (!['minor', 'mismatch'].includes(scaledResult.status)) {
      throw new Error(`缩放片结论应为 minor / mismatch，实际 ${scaledResult.status}`);
    }

    log('全部通过', { dataDir, keep: keep ? root : '(已清理)' });
  } finally {
    daemon.kill('SIGKILL');
    statics.server.close();
    if (!keep) rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
