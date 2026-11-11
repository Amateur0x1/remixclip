/**
 * [INPUT]: an explicit `--version`, REMIXCLIP_VERSION, the CI tag ref, or apps/desktop/package.json.
 * [OUTPUT]: one validated x.y.z[-prerelease] version plus where it came from.
 * [POS]: Version authority for packaging; every artifact and manifest reads the result of resolveVersion().
 */
import { readJson } from './context.js';

export interface ParsedVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(input: string): ParsedVersion | null {
  const match = SEMVER.exec(input.trim().replace(/^v/, ''));
  if (!match) return null;
  const result: ParsedVersion = {
    raw: match[0],
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  if (match[4]) result.prerelease = match[4];
  return result;
}

export function normalizeVersion(input: string, source: string): string {
  const parsed = parseVersion(input);
  if (!parsed) {
    throw new Error(`invalid version "${input}" from ${source}; expected x.y.z or x.y.z-<prerelease>`);
  }
  return parsed.raw;
}

export function isPrerelease(version: string): boolean {
  return Boolean(parseVersion(version)?.prerelease);
}

/**
 * Release channel used by the manifest and GitHub release metadata.
 *
 * Snapshot builds of `main` ship the plain package version (so artifact names stay clean and
 * readable, e.g. `RemixClip-0.1.0-mac-arm64.dmg`), which would otherwise read as `stable`. CI
 * therefore passes its resolved channel explicitly through `REMIXCLIP_CHANNEL`.
 */
export function releaseChannel(version: string): 'stable' | 'prerelease' {
  const forced = process.env.REMIXCLIP_CHANNEL;
  if (forced === 'stable' || forced === 'prerelease') return forced;
  return isPrerelease(version) ? 'prerelease' : 'stable';
}

export interface ResolveVersionOptions {
  explicit?: unknown;
  env?: NodeJS.ProcessEnv;
  refName?: string;
  packageFile: string;
}

export interface ResolvedVersion {
  version: string;
  source: string;
}

/**
 * Precedence: --version > REMIXCLIP_VERSION > tag ref (vX.Y.Z) > apps/desktop/package.json.
 * A tag is authoritative in CI: a mistyped local file must not silently ship under the wrong tag.
 */
export function resolveVersion(options: ResolveVersionOptions): ResolvedVersion {
  const { explicit, env = process.env, refName, packageFile } = options;

  if (typeof explicit === 'string' && explicit.length > 0) {
    return { version: normalizeVersion(explicit, '--version'), source: 'cli' };
  }

  const fromEnv = env.REMIXCLIP_VERSION;
  if (fromEnv && fromEnv.length > 0) {
    return { version: normalizeVersion(fromEnv, 'REMIXCLIP_VERSION'), source: 'env' };
  }

  const tag = refName ?? env.GITHUB_REF_NAME;
  if (tag && parseVersion(tag) && /^v?\d/.test(tag)) {
    return { version: normalizeVersion(tag, 'GITHUB_REF_NAME'), source: 'tag' };
  }

  const manifest = readJson<{ version?: string }>(packageFile);
  const fileVersion = manifest.version ?? '';
  return {
    version: normalizeVersion(fileVersion, packageFile),
    source: 'package.json',
  };
}
