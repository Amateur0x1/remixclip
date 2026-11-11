/**
 * [INPUT]: FFMPEG_PATH / FFPROBE_PATH env vars, binaries from installer packages or the
 *   system PATH, and local video files.
 * [OUTPUT]: Resolved binary paths, subprocess execution wrappers and ffprobe metadata
 *   (duration / width and height / fps).
 * [POS]: Process layer shared by library media handling (download probing / shot analysis /
 *   pixel verification); when missing it always throws "ffmpeg unavailable", never
 *   degrading silently.
 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
}

export interface VideoMeta {
  durationMs?: number;
  width?: number;
  height?: number;
  fps?: number;
}

const FFMPEG_UNAVAILABLE = 'ffmpeg 不可用';

let cache: FfmpegBinaries | null = null;
let resolved = false;

/**
 * Installer packages expose the binary path on the module's `path` field (null when
 * not installed / unsupported platform).
 */
function fromInstaller(specifier: string): string | null {
  try {
    const mod = require(specifier) as { path?: unknown };
    if (typeof mod?.path !== 'string' || !existsSync(mod.path)) return null;
    // The packaged binary gets its exec bit from postinstall; add it here if pnpm blocked
    // the build script.
    try {
      accessSync(mod.path, constants.X_OK);
    } catch {
      chmodSync(mod.path, 0o755);
    }
    return mod.path;
  } catch {
    return null;
  }
}

function fromEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value && existsSync(value) ? value : null;
}

/**
 * PATH fallback: actually run `-version` once to confirm it executes, so 'not installed'
 * is not mistaken for 'installed'.
 */
function fromPath(name: string): string | null {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore', timeout: 5000 });
    return name;
  } catch {
    return null;
  }
}

/**
 * Probe once on the first call after startup and cache it; null means this machine has
 * no usable ffmpeg.
 */
export function resolveFfmpeg(): FfmpegBinaries | null {
  if (resolved) return cache;
  resolved = true;
  const ffmpeg = fromEnv('FFMPEG_PATH')
    ?? fromInstaller('@ffmpeg-installer/ffmpeg')
    ?? fromPath('ffmpeg');
  const ffprobe = fromEnv('FFPROBE_PATH')
    ?? fromInstaller('@ffprobe-installer/ffprobe')
    ?? fromPath('ffprobe');
  cache = ffmpeg && ffprobe ? { ffmpeg, ffprobe } : null;
  if (!cache) console.warn('[remixclip] 未找到 ffmpeg / ffprobe，下载与拉片接口将不可用');
  return cache;
}

export function requireFfmpeg(): FfmpegBinaries {
  const bins = resolveFfmpeg();
  if (!bins) throw new Error(FFMPEG_UNAVAILABLE);
  return bins;
}

/** In execFile failures stderr holds ffmpeg's real reason; fold it into the Error here. */
function toError(error: unknown): Error {
  if (error && typeof error === 'object') {
    const stderr = (error as { stderr?: unknown }).stderr;
    const first = typeof stderr === 'string'
      ? stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join(' ')
      : '';
    if (first) return new Error(first);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface RunFfmpegOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

/**
 * Run ffmpeg once and return stderr (scene detection parses time points from the
 * showinfo lines).
 */
export async function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<string> {
  const bins = requireFfmpeg();
  try {
    const { stderr } = await execFileAsync(bins.ffmpeg, args, {
      maxBuffer: options.maxBufferBytes ?? 32 * 1024 * 1024,
      timeout: options.timeoutMs ?? 10 * 60_000,
    });
    return String(stderr ?? '');
  } catch (error) {
    throw toError(error);
  }
}

export interface ExtractFrameOptions {
  input: string;
  /** Sample timestamp (ms); -ss goes before -i to use fast seek. */
  atMs: number;
  output: string;
  /** Scale / letterbox filter chain; no scaling when omitted. */
  filter?: string;
  /** jpg output quality (-q:v), unneeded for png. */
  quality?: number;
}

/**
 * Extract a single frame to jpg/png: shot-analysis thumbnails and pixel-verification
 * sample frames share one command.
 */
export async function extractFrame(options: ExtractFrameOptions): Promise<void> {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-ss', (Math.max(0, options.atMs) / 1000).toFixed(3),
    '-i', options.input,
    '-frames:v', '1',
  ];
  if (options.filter) args.push('-vf', options.filter);
  if (options.quality != null) args.push('-q:v', String(options.quality));
  args.push(options.output);
  await runFfmpeg(args, { timeoutMs: 60_000 });
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.includes('/')) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  const [num, den] = value.split('/').map(Number);
  if (!num || !den) return undefined;
  const rate = num / den;
  return Number.isFinite(rate) && rate > 0 ? rate : undefined;
}

function parseSeconds(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * ffprobe the video metadata; throws on failure and lets the caller decide about degrading
 * (a successful download may lack metadata).
 */
export async function probeVideo(file: string): Promise<VideoMeta> {
  const bins = requireFfmpeg();
  let stdout: string;
  try {
    const result = await execFileAsync(
      bins.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
    );
    stdout = String(result.stdout ?? '');
  } catch (error) {
    throw toError(error);
  }

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }[];
  };
  const stream = parsed.streams?.find((item) => item.codec_type === 'video');
  const duration = parseSeconds(parsed.format?.duration) ?? parseSeconds(stream?.duration);
  return {
    durationMs: duration ? Math.round(duration * 1000) : undefined,
    width: stream?.width && stream.width > 0 ? stream.width : undefined,
    height: stream?.height && stream.height > 0 ? stream.height : undefined,
    fps: parseRate(stream?.avg_frame_rate) ?? parseRate(stream?.r_frame_rate),
  };
}
