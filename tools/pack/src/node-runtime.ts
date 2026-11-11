/**
 * [INPUT]: a pinned Node version plus the target platform/arch and a cache directory.
 * [OUTPUT]: an extracted standalone Node runtime whose ABI matches better-sqlite3, verified against SHASUMS256.txt.
 * [POS]: Runtime provenance for packaged builds; the daemon is always spawned with this binary, never the host Node.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ensureDir,
  hostArch,
  hostMatches,
  hostPlatform,
  removeDir,
  run,
  type Arch,
  type Logger,
  type Platform,
} from './context.js';

export interface NodeRuntime {
  version: string;
  extractDir: string;
  binary: string;
  archive: string;
}

export interface NodeRuntimeOptions {
  platform: Platform;
  arch: Arch;
  version: string;
  cacheDir: string;
  logger: Logger;
}

interface Distribution {
  dirName: string;
  archiveName: string;
}

export function nodeDistribution(platform: Platform, arch: Arch, version: string): Distribution {
  const nodeOs = platform === 'mac' ? 'darwin' : platform === 'win' ? 'win' : 'linux';
  const extension = platform === 'win' ? 'zip' : 'tar.gz';
  const dirName = `node-v${version}-${nodeOs}-${arch}`;
  return { dirName, archiveName: `${dirName}.${extension}` };
}

function mirror(): string {
  return (process.env.REMIXCLIP_NODE_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '');
}

async function download(url: string, destination: string): Promise<void> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
  }
  const partial = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, destination);
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function expectedSha256(version: string, archiveName: string, cacheDir: string, logger: Logger): Promise<string | null> {
  const manifestPath = path.join(cacheDir, `SHASUMS256-${version}.txt`);
  if (!existsSync(manifestPath)) {
    const url = `${mirror()}/v${version}/SHASUMS256.txt`;
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = await response.text();
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(manifestPath, body);
    } catch (error) {
      logger.warn(
        `could not fetch ${url} (${error instanceof Error ? error.message : String(error)}); ` +
          'continuing without archive checksum verification',
      );
      return null;
    }
  }

  const line = readFileSync(manifestPath, 'utf8')
    .split('\n')
    .find((entry) => entry.trim().endsWith(`  ${archiveName}`) || entry.trim().endsWith(` *${archiveName}`));
  return line ? line.trim().split(/\s+/)[0] ?? null : null;
}

/**
 * Node ships one tarball/zip per platform; the archive is cached so repeated local packaging
 * is offline after the first download. Integrity is fail-open only when the checksum file is
 * unreachable (corporate mirrors), and never silently on a hash mismatch.
 */
export async function ensureNodeRuntime(options: NodeRuntimeOptions): Promise<NodeRuntime> {
  const { platform, arch, version, cacheDir, logger } = options;
  const dist = nodeDistribution(platform, arch, version);
  const extractDir = path.join(cacheDir, dist.dirName);
  const archive = path.join(cacheDir, dist.archiveName);
  const binary = path.join(extractDir, platform === 'win' ? 'node.exe' : path.join('bin', 'node'));

  ensureDir(cacheDir);

  if (!existsSync(archive)) {
    logger.step(`downloading Node ${version} (${platform}/${arch})`);
    await download(`${mirror()}/v${version}/${dist.archiveName}`, archive);
  }

  const expected = await expectedSha256(version, dist.archiveName, cacheDir, logger);
  // Re-verify a cached archive too: a truncated first download must not poison later runs.
  if (expected) {
    const actual = await sha256(archive);
    if (actual !== expected) {
      rmSync(archive, { force: true });
      throw new Error(
        `Node ${version} archive checksum mismatch for ${dist.archiveName}: expected ${expected}, got ${actual}`,
      );
    }
    logger.info(`verified Node ${version} archive sha256`);
  }

  if (!existsSync(binary)) {
    logger.step(`extracting ${dist.archiveName}`);
    removeDir(extractDir);
    ensureDir(extractDir);
    // Windows ships a .zip; the built-in bsdtar handles it like a tarball.
    run('tar', ['-xf', archive, '-C', extractDir, '--strip-components=1']);
  }

  if (!existsSync(binary)) {
    throw new Error(`Node ${version} binary missing after extraction: ${binary}`);
  }
  if (platform !== 'win') chmodSync(binary, 0o755);

  return { version, extractDir, binary, archive };
}

/**
 * better-sqlite3 (and every other native addon in the daemon) is compiled by `pnpm install`
 * against the *host* Node ABI. Shipping a runtime with a different ABI produces an installer
 * that dies on first launch, so refuse before the expensive build starts.
 */
export function assertNodeAbi(
  platform: Platform,
  arch: Arch,
  nodeVersion: string,
  logger: Logger,
): void {
  const targetMajor = nodeVersion.split('.')[0];
  const hostMajor = process.versions.node.split('.')[0];

  if (targetMajor !== hostMajor) {
    if (process.env.REMIXCLIP_ALLOW_ABI_MISMATCH === '1') {
      logger.warn(
        `bundled Node ${nodeVersion} (major ${targetMajor}) does not match host Node ${process.versions.node}; ` +
          'continuing because REMIXCLIP_ALLOW_ABI_MISMATCH=1',
      );
      return;
    }
    throw new Error(
      `bundled Node ${nodeVersion} (major ${targetMajor}) does not match host Node ${process.versions.node} (major ${hostMajor}). ` +
        'Native modules such as better-sqlite3 would be compiled for the wrong ABI. ' +
        'Use Node matching the bundled runtime (see .github/workflows/release.yml), ' +
        'pass --node-version with the host major, or set REMIXCLIP_ALLOW_ABI_MISMATCH=1 explicitly.',
    );
  }

  if (!hostMatches(platform, arch)) {
    logger.warn(
      `cross-arch packaging (${platform}/${arch} on ${hostPlatform()}/${hostArch()}): ` +
        'native modules are installed for the host arch and may not run in the bundle',
    );
  }
}

/** Copies the runtime into the staging tree using the layout the desktop shell expects. */
export function copyNodeRuntime(runtime: NodeRuntime, platform: Platform, stageDir: string): void {
  const nodeStage = path.join(stageDir, 'node');
  ensureDir(nodeStage);
  if (platform === 'win') {
    copyFileSync(runtime.binary, path.join(nodeStage, 'node.exe'));
  } else {
    ensureDir(path.join(nodeStage, 'bin'));
    const destination = path.join(nodeStage, 'bin', 'node');
    copyFileSync(runtime.binary, destination);
    chmodSync(destination, 0o755);
  }
  const license = path.join(runtime.extractDir, 'LICENSE');
  if (existsSync(license)) copyFileSync(license, path.join(nodeStage, 'LICENSE'));
}
