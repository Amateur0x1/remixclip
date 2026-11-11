/**
 * [INPUT]: built workspace outputs, the pinned Node runtime, and packaging metadata.
 * [OUTPUT]: apps/desktop/.release-stage with the exact Resources/ layout the desktop shell spawns.
 * [POS]: Single staging authority shared by local packaging and CI.
 *
 * Layout contract with apps/desktop/src/main/index.ts (all under Resources/ once packaged):
 *   daemon/dist/cli.js   ← pnpm deploy of @remixclip/daemon (dist + production node_modules)
 *   web-out/index.html   ← apps/web static export
 *   node/bin/node        ← standalone Node runtime whose ABI matches better-sqlite3
 *   node/node.exe        ← same, Windows layout
 *   extension/           ← built browser companion (daemon serves it as a zip download)
 *   remixclip.png        ← window / dock icon
 *   licenses/            ← LICENSE / NOTICE / THIRD_PARTY_NOTICES.md
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  DAEMON_DIR,
  DESKTOP_DIR,
  EXTENSION_DIR,
  PRODUCT_NAME,
  REPO_ROOT,
  resolveWebExportDir,
  copyDir,
  ensureDir,
  readJson,
  removeDir,
  run,
  writeJson,
  type Arch,
  type Logger,
  type Platform,
} from './context.js';
import { copyNodeRuntime, ensureNodeRuntime, type NodeRuntime } from './node-runtime.js';

export interface StageOptions {
  version: string;
  platform: Platform;
  arch: Arch;
  nodeVersion: string;
  stageDir: string;
  cacheDir: string;
  logger: Logger;
}

export interface StagedResources {
  stageDir: string;
  runtime: NodeRuntime;
  stagedAt: string;
}

export interface StageManifest {
  schemaVersion: 1;
  product: string;
  version: string;
  platform: Platform;
  arch: Arch;
  nodeVersion: string;
  stagedAt: string;
}

function requireFile(file: string, hint: string): void {
  if (!existsSync(file)) {
    throw new Error(`staging input missing: ${file}${hint ? `\n  ${hint}` : ''}`);
  }
}

function deployDaemon(stageDir: string, logger: Logger): void {
  const daemonStage = path.join(stageDir, 'daemon');
  // dist + a hoisted production node_modules (no virtual-store symlinks), so the copy into
  // the app bundle is plain files and require() keeps resolving.
  run(
    'pnpm',
    [
      '--filter',
      '@remixclip/daemon',
      'deploy',
      '--prod',
      '--legacy',
      '--config.node-linker=hoisted',
      daemonStage,
    ],
    { logger },
  );
  requireFile(
    path.join(daemonStage, 'dist', 'cli.js'),
    'build @remixclip/daemon before packaging (pnpm --filter @remixclip/daemon build)',
  );
  const ffmpegInstallerDir = path.join(DAEMON_DIR, 'node_modules', '@ffmpeg-installer');
  const installers = existsSync(ffmpegInstallerDir)
    ? readdirSync(ffmpegInstallerDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  if (installers.length === 0) {
    logger.warn('no @ffmpeg-installer platform package found in apps/daemon/node_modules');
  }
}

export async function stageResources(options: StageOptions): Promise<StagedResources> {
  const { version, platform, arch, nodeVersion, stageDir, cacheDir, logger } = options;

  removeDir(stageDir);
  ensureDir(stageDir);

  logger.step('staging daemon (pnpm deploy, production dependencies)');
  deployDaemon(stageDir, logger);

  const webOut = resolveWebExportDir();
  requireFile(
    path.join(webOut, 'index.html'),
    'build @remixclip/web before packaging (pnpm --filter @remixclip/web build)',
  );
  logger.step('staging web static export');
  copyDir(webOut, path.join(stageDir, 'web-out'));

  const extensionDist = path.join(EXTENSION_DIR, 'dist');
  requireFile(
    path.join(extensionDist, 'manifest.json'),
    'build the browser companion before packaging (pnpm extension:build)',
  );
  logger.step('staging browser companion');
  copyDir(extensionDist, path.join(stageDir, 'extension'));

  // Skill library: markdown the agent reads on demand (resolved by apps/daemon/src/skills.ts
  // through OD_SKILLS_DIR). It ships as plain files, never inside the asar.
  const skillsRoot = path.join(REPO_ROOT, 'skills');
  requireFile(
    path.join(skillsRoot, 'manifest.json'),
    'the vendored skill library must exist at <repo>/skills (see skills/manifest.json)',
  );
  logger.step('staging skill library');
  copyDir(skillsRoot, path.join(stageDir, 'skills'));

  // Apache-2.0 distributions must ship the license, NOTICE and third-party inventory.
  const licensesStage = path.join(stageDir, 'licenses');
  ensureDir(licensesStage);
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    requireFile(path.join(REPO_ROOT, name), 'the repository license files must exist at the repo root');
    copyFileSync(path.join(REPO_ROOT, name), path.join(licensesStage, name));
  }
  copyFileSync(
    path.join(EXTENSION_DIR, 'LICENSE'),
    path.join(licensesStage, 'LICENSE-remixclip-companion'),
  );
  copyFileSync(
    path.join(EXTENSION_DIR, 'NOTICE.md'),
    path.join(licensesStage, 'NOTICE-remixclip-companion.md'),
  );

  logger.step(`staging Node ${nodeVersion} runtime`);
  const runtime = await ensureNodeRuntime({ platform, arch, version: nodeVersion, cacheDir, logger });
  copyNodeRuntime(runtime, platform, stageDir);

  const stagedAt = new Date().toISOString();
  const manifest: StageManifest = {
    schemaVersion: 1,
    product: PRODUCT_NAME,
    version,
    platform,
    arch,
    nodeVersion,
    stagedAt,
  };
  writeJson(path.join(stageDir, 'stage.json'), manifest);

  const desktopVersion = readJson<{ version?: string }>(path.join(DESKTOP_DIR, 'package.json')).version;
  if (desktopVersion && desktopVersion !== version) {
    logger.warn(
      `apps/desktop/package.json is ${desktopVersion} but this build is ${version}; ` +
        'electron-builder stamps the build version, the file is left untouched',
    );
  }

  return { stageDir, runtime, stagedAt };
}
