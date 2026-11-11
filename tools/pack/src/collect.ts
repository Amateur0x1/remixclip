/**
 * [INPUT]: a release directory containing installers, plus build identity metadata.
 * [OUTPUT]: a per-platform manifest.json and SHA256SUMS file describing every publishable artifact.
 * [POS]: The hand-off contract between per-platform build jobs and the publish job.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DESKTOP_DIR,
  PRODUCT_NAME,
  REPO_ROOT,
  archSpellings,
  ensureDir,
  readJson,
  tryCapture,
  type Arch,
  type Logger,
  type Platform,
} from './context.js';
import { releaseChannel } from './version.js';

const ARTIFACT_EXTENSIONS = ['.dmg', '.zip', '.exe', '.AppImage', '.blockmap', '.yml', '.yaml'];

export interface ArtifactRecord {
  file: string;
  bytes: number;
  sha256: string;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  product: string;
  version: string;
  channel: 'stable' | 'prerelease';
  platform: Platform;
  arch: Arch;
  electron: string;
  node: string;
  git: {
    commit: string | null;
    ref: string | null;
    dirty: boolean;
  };
  builtAt: string;
  checksumsFile: string;
  artifacts: ArtifactRecord[];
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** Publishable files only: installers, update metadata and blockmaps; never builder debug output. */
export function listArtifactFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => {
      const full = path.join(dir, name);
      try {
        if (!statSync(full).isFile()) return false;
      } catch {
        return false;
      }
      if (name.startsWith('builder-')) return false;
      if (name.startsWith('SHA256SUMS')) return false;
      if (name.endsWith('-manifest.json')) return false;
      return ARTIFACT_EXTENSIONS.some((extension) => name.endsWith(extension));
    })
    .sort();
}

function electronVersion(): string {
  const candidates = [
    path.join(DESKTOP_DIR, 'node_modules', 'electron', 'package.json'),
    path.join(REPO_ROOT, 'node_modules', 'electron', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return readJson<{ version?: string }>(candidate).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown';
}

function gitIdentity(): ReleaseManifest['git'] {
  const commit = tryCapture('git', ['rev-parse', 'HEAD']);
  const status = tryCapture('git', ['status', '--porcelain']);
  const ref = process.env.GITHUB_REF_NAME ?? tryCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  return { commit, ref, dirty: Boolean(status && status.length > 0) };
}

export interface CollectOptions {
  platform: Platform;
  arch: Arch;
  version: string;
  nodeVersion: string;
  releaseDir: string;
  /** Destination for the manifest + checksums; defaults to releaseDir. */
  outDir?: string;
  logger: Logger;
}

export interface CollectResult {
  manifest: ReleaseManifest;
  manifestPath: string;
  checksumsPath: string;
  artifacts: string[];
}

export async function collectRelease(options: CollectOptions): Promise<CollectResult> {
  const { platform, arch, version, nodeVersion, releaseDir, logger } = options;
  const outDir = options.outDir ?? releaseDir;

  if (!existsSync(releaseDir)) {
    throw new Error(`release directory does not exist: ${releaseDir}`);
  }
  ensureDir(outDir);

  const names = listArtifactFiles(releaseDir);
  if (names.length === 0) {
    throw new Error(`no installers found in ${releaseDir}; packaging did not produce a publishable artifact`);
  }

  // A release tree can hold artifacts from an earlier version; never bless them under a new tag.
  const identities = archSpellings(arch).map((spelling) => `-${version}-${platform}-${spelling}.`);
  for (const name of names) {
    if (!/\.(dmg|zip|exe|AppImage|blockmap)$/.test(name)) continue;
    if (!identities.some((identity) => name.includes(identity))) {
      throw new Error(
        `artifact ${name} does not belong to ${version}/${platform}/${arch}; ` +
          'run the build for this version instead of collecting an older tree',
      );
    }
  }

  const artifacts: ArtifactRecord[] = [];
  for (const name of names) {
    const source = path.join(releaseDir, name);
    const destination = path.join(outDir, name);
    if (path.resolve(source) !== path.resolve(destination)) copyFileSync(source, destination);

    const bytes = statSync(destination).size;
    const digest = await sha256File(destination);
    artifacts.push({ file: name, bytes, sha256: digest });
    logger.info(`  ${digest.slice(0, 12)}…  ${name}  (${bytes} bytes)`);
  }

  const checksumsFile = `SHA256SUMS-${platform}-${arch}.txt`;
  const checksums = artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.file}`)
    .sort()
    .join('\n');
  const checksumsPath = path.join(outDir, checksumsFile);
  writeFileSync(checksumsPath, `${checksums}\n`);

  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    version,
    channel: releaseChannel(version),
    platform,
    arch,
    electron: electronVersion(),
    node: nodeVersion,
    git: gitIdentity(),
    builtAt: new Date().toISOString(),
    checksumsFile,
    artifacts,
  };

  const manifestPath = path.join(outDir, `${PRODUCT_NAME}-${version}-${platform}-${arch}-manifest.json`);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { manifest, manifestPath, checksumsPath, artifacts: artifacts.map((artifact) => artifact.file) };
}
