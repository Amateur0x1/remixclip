/**
 * [INPUT]: CLI args (`<platform> <action>`), the workspace sources, and environment credentials.
 * [OUTPUT]: verified installers plus a manifest/SHA256SUMS hand-off, or a machine-readable JSON report.
 * [POS]: The single packaging entry point used locally and by .github/workflows/release.yml.
 */
import { cac } from 'cac';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_CACHE_DIR,
  DEFAULT_NODE_VERSION,
  DEFAULT_RELEASE_DIR,
  DEFAULT_STAGE_DIR,
  DESKTOP_DIR,
  REPO_ROOT,
  createLogger,
  ensureDir,
  formatBytes,
  hostArch,
  normalizeArch,
  normalizePlatform,
  removeDir,
  resolveWebExportDir,
  tryCapture,
  type Arch,
  type Logger,
} from './context.js';
import { acquireBuildLock } from './lock.js';
import { stageResources } from './stage.js';
import { assertNodeAbi } from './node-runtime.js';
import { buildWorkspace } from './workspace-build.js';
import { packageApp, parseSignMode, resolveSigning } from './builder.js';
import { parseTargets, type TargetKind } from './targets.js';
import { VerificationError, assertVerified, verifyRelease, type VerificationReport } from './verify.js';
import { collectRelease } from './collect.js';
import { releaseChannel, resolveVersion } from './version.js';

type Flags = Record<string, unknown>;

const PACKAGE_FILE = path.join(DESKTOP_DIR, 'package.json');

function stringFlag(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boolFlag(value: unknown): boolean {
  return value === true;
}

function resolveArch(flags: Flags): Arch {
  const value = stringFlag(flags.arch);
  return value ? normalizeArch(value) : hostArch();
}

function resolvePaths(flags: Flags): {
  releaseDir: string;
  stageDir: string;
  cacheDir: string;
} {
  return {
    releaseDir: path.resolve(stringFlag(flags.out) ?? DEFAULT_RELEASE_DIR),
    stageDir: path.resolve(stringFlag(flags.stage) ?? DEFAULT_STAGE_DIR),
    cacheDir: path.resolve(stringFlag(flags.cache) ?? DEFAULT_CACHE_DIR),
  };
}

function resolveVersionSafe(flags: Flags): { version: string; source: string } {
  return resolveVersion({
    explicit: flags.version,
    packageFile: PACKAGE_FILE,
    env: process.env,
  });
}

function writeJsonReport(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printVerification(logger: Logger, report: VerificationReport): void {
  const passed = report.checks.filter((check) => check.ok).length;
  logger.step(`verification: ${passed}/${report.checks.length} checks passed`);
}

// ── Commands ───────────────────────────────────────────────────────────────

async function buildCommand(platformArg: string, flags: Flags): Promise<void> {
  const platform = normalizePlatform(platformArg);
  const arch = resolveArch(flags);
  const logger = createLogger(boolFlag(flags.json));

  const { version, source } = resolveVersionSafe(flags);
  // cac camelCases multi-word flags (`--node-version` → `nodeVersion`).
  const nodeVersion = stringFlag(flags.nodeVersion) ?? DEFAULT_NODE_VERSION;
  const { releaseDir, stageDir, cacheDir } = resolvePaths(flags);
  const targets = parseTargets(platform, flags.to);
  const dirOnly = targets.length === 1 && targets[0] === 'dir';
  const signing = resolveSigning(platform, parseSignMode(flags.sign), boolFlag(flags.notarize), logger);
  const publish = stringFlag(flags.publish) ?? 'never';

  logger.step(
    `RemixClip ${version} (from ${source}) · ${platform}/${arch} · Node ${nodeVersion}` +
      (dirOnly ? ' · dir only' : ''),
  );
  ensureDir(releaseDir);

  // Fail before the expensive workspace build if the bundled runtime cannot load the
  // host-compiled native modules.
  assertNodeAbi(platform, arch, nodeVersion, logger);

  const releaseLock = acquireBuildLock(releaseDir, logger);
  try {
    buildWorkspace({ logger, skip: boolFlag(flags.skipBuild) });

    await stageResources({
      version,
      platform,
      arch,
      nodeVersion,
      stageDir,
      cacheDir,
      logger,
    });

    packageApp({
      platform,
      arch,
      targets,
      version,
      releaseDir,
      publish,
      compression: stringFlag(flags.compression),
      signing,
      logger,
    });

    const report = verifyRelease({
      platform,
      arch,
      version,
      releaseDir,
      stageDir,
      targets,
      expectInstallers: !dirOnly,
      logger,
      skipSmoke: flags.smoke === false,
    });
    assertVerified(report);
    printVerification(logger, report);

    // `--to dir` produces no installer, so there is nothing to hand off to a release.
    // Returning here also prevents stale installers from being collected into a manifest.
    if (dirOnly) {
      if (logger.json) {
        writeJsonReport({ ok: true, dirOnly: true, appDir: report.appDir, verification: report });
      } else {
        logger.step(`unpacked app: ${report.appDir ?? '(not found)'}`);
      }
      return;
    }

    const collected = await collectRelease({
      platform,
      arch,
      version,
      nodeVersion,
      releaseDir,
      logger,
    });

    if (logger.json) {
      writeJsonReport({
        ok: true,
        manifest: collected.manifest,
        manifestPath: collected.manifestPath,
        checksumsPath: collected.checksumsPath,
        verification: report,
      });
      return;
    }

    logger.step(`artifacts in ${releaseDir}`);
    for (const artifact of collected.manifest.artifacts) {
      logger.info(`  ${artifact.file}  (${formatBytes(artifact.bytes)})`);
    }
    logger.step(`manifest  ${path.relative(REPO_ROOT, collected.manifestPath)}`);
    logger.step(`checksums ${path.relative(REPO_ROOT, collected.checksumsPath)}`);
  } finally {
    releaseLock();
  }
}

async function verifyCommand(platformArg: string, flags: Flags): Promise<void> {
  const platform = normalizePlatform(platformArg);
  const arch = resolveArch(flags);
  const logger = createLogger(boolFlag(flags.json));
  const { version } = resolveVersionSafe(flags);
  const { releaseDir, stageDir } = resolvePaths(flags);
  const targets = parseTargets(platform, flags.to);

  const report = verifyRelease({
    platform,
    arch,
    version,
    releaseDir,
    stageDir,
    targets,
    expectInstallers: !(targets.length === 1 && targets[0] === 'dir'),
    logger,
    skipSmoke: flags.smoke === false,
  });

  if (logger.json) writeJsonReport({ ok: report.ok, verification: report });
  if (!report.ok) throw new VerificationError(report);
}

async function collectCommand(platformArg: string, flags: Flags): Promise<void> {
  const platform = normalizePlatform(platformArg);
  const arch = resolveArch(flags);
  const logger = createLogger(boolFlag(flags.json));
  const { version } = resolveVersionSafe(flags);
  const nodeVersion = stringFlag(flags.nodeVersion) ?? DEFAULT_NODE_VERSION;
  // `collect` reads an existing release tree and writes the hand-off elsewhere; `--out` is
  // the destination here, while `--from` names the source.
  const sourceDir = stringFlag(flags.from);
  const releaseDir = sourceDir ? path.resolve(sourceDir) : DEFAULT_RELEASE_DIR;
  const outDir = stringFlag(flags.out);

  const collected = await collectRelease({
    platform,
    arch,
    version,
    nodeVersion,
    releaseDir,
    outDir: outDir ? path.resolve(outDir) : undefined,
    logger,
  });

  if (logger.json) {
    writeJsonReport({
      ok: true,
      manifest: collected.manifest,
      manifestPath: collected.manifestPath,
      checksumsPath: collected.checksumsPath,
    });
  } else {
    logger.step(`manifest  ${collected.manifestPath}`);
    logger.step(`checksums ${collected.checksumsPath}`);
  }
}

async function cleanCommand(_platformArg: string, flags: Flags): Promise<void> {
  const logger = createLogger(boolFlag(flags.json));
  const { releaseDir, stageDir, cacheDir } = resolvePaths(flags);
  const all = boolFlag(flags.all);

  const targets: Array<[string, string]> = [];
  if (all || boolFlag(flags.release)) targets.push(['release', releaseDir]);
  if (all || boolFlag(flags.withCache)) targets.push(['cache', cacheDir]);
  if (targets.length === 0) targets.push(['stage', stageDir]);

  const removed: string[] = [];
  for (const [name, dir] of targets) {
    if (!existsSync(dir)) continue;
    removeDir(dir);
    removed.push(name);
  }

  if (logger.json) writeJsonReport({ ok: true, removed, targets: Object.fromEntries(targets) });
  else logger.step(removed.length === 0 ? 'nothing to clean' : `removed ${removed.join(', ')}`);
}

function doctorCommand(flags: Flags): void {
  const logger = createLogger(boolFlag(flags.json));
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const lastLine = (value: string | null): string | null =>
    value ? (value.split('\n').filter((line) => line.trim().length > 0).pop() ?? null) : null;
  const pnpmVersion = lastLine(tryCapture('pnpm', ['-v']));
  const builderVersion = lastLine(tryCapture('pnpm', ['exec', 'electron-builder', '--version']));
  const gitCommit = tryCapture('git', ['rev-parse', '--short', 'HEAD']);

  const required = [
    { name: 'node ≥ 22', ok: nodeMajor >= 22, detail: process.version },
    { name: 'pnpm', ok: Boolean(pnpmVersion), detail: pnpmVersion ?? 'not found' },
    { name: 'electron-builder', ok: Boolean(builderVersion), detail: builderVersion ?? 'not installed' },
  ];

  const { releaseDir, stageDir, cacheDir } = resolvePaths(flags);
  const optional = [
    { name: 'daemon dist', ok: existsSync(path.join(REPO_ROOT, 'apps', 'daemon', 'dist', 'cli.js')) },
    { name: 'web export', ok: existsSync(path.join(resolveWebExportDir(), 'index.html')) },
    {
      name: 'browser companion dist',
      ok: existsSync(path.join(REPO_ROOT, 'extensions', 'remixclip-companion', 'dist', 'manifest.json')),
    },
    { name: 'release dir', ok: existsSync(releaseDir), detail: releaseDir },
    { name: 'stage dir', ok: existsSync(stageDir), detail: stageDir },
    { name: 'runtime cache', ok: existsSync(cacheDir), detail: cacheDir },
    { name: 'git', ok: Boolean(gitCommit), detail: gitCommit ?? 'not a git checkout' },
  ];

  if (logger.json) {
    writeJsonReport({ ok: required.every((check) => check.ok), required, optional });
  } else {
    for (const check of required) {
      logger.info(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
    for (const check of optional) {
      logger.info(`${check.ok ? 'ok  ' : 'warn'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
    }
  }

  if (!required.every((check) => check.ok)) process.exitCode = 1;
}

function versionCommand(flags: Flags): void {
  const { version, source } = resolveVersionSafe(flags);
  if (boolFlag(flags.json)) {
    writeJsonReport({ version, source, channel: releaseChannel(version) });
    return;
  }
  process.stdout.write(`${version}\n`);
  process.stderr.write(`[tools-pack] source: ${source} · channel: ${releaseChannel(version)}\n`);
}

// ── Wiring ─────────────────────────────────────────────────────────────────

const cli = cac('tools-pack');

cli
  .command(
    '<platform> <action>',
    'Build, verify, collect or clean a packaged release (platform: mac | win | linux)',
  )
  .option('--to <targets>', 'Comma separated targets: all, dir, dmg, zip, nsis, appimage', {
    default: 'all',
  })
  .option('--arch <arch>', 'Target arch: arm64 or x64 (defaults to the host)')
  .option('--version <version>', 'Version to stamp (defaults to tag/env/package.json)')
  .option('--node-version <version>', 'Bundled Node runtime version')
  .option('--out <dir>', 'Release output directory (collect: destination)')
  .option('--from <dir>', 'collect: source release directory')
  .option('--stage <dir>', 'Staging directory')
  .option('--cache <dir>', 'Download/build cache directory')
  .option('--skip-build', 'Reuse existing workspace builds')
  .option('--publish <mode>', 'electron-builder publish mode: never, onTag, always', {
    default: 'never',
  })
  .option('--compression <mode>', 'electron-builder compression: store, normal, maximum')
  .option('--sign [mode]', 'Code signing: auto (default), always, never')
  .option('--notarize', 'Notarize the macOS build (requires Apple credentials)')
  .option('--no-smoke', 'Skip the bundled runtime smoke test')
  .option('--all', 'clean: also remove release and cache directories')
  .option('--release', 'clean: remove the release directory')
  .option('--with-cache', 'clean: remove the runtime cache directory')
  .action((platformArg: string, action: string, flags: Flags) => {
    const run = async () => {
      switch (action) {
        case 'build':
          return buildCommand(platformArg, flags);
        case 'verify':
          return verifyCommand(platformArg, flags);
        case 'collect':
          return collectCommand(platformArg, flags);
        case 'clean':
          return cleanCommand(platformArg, flags);
        default:
          throw new Error(`unknown action "${action}"; expected build, verify, collect or clean`);
      }
    };
    // Returning the promise lets the top-level `await cli.runMatchedCommand()` keep the
    // process alive until packaging actually finishes.
    return run().catch((error) => reportFailure(error, flags));
  });

cli.command('doctor', 'Check the local packaging toolchain').action((flags: Flags) => {
  try {
    doctorCommand(flags);
  } catch (error) {
    reportFailure(error, flags);
  }
});

cli.command('version', 'Print the resolved release version').action((flags: Flags) => {
  try {
    versionCommand(flags);
  } catch (error) {
    reportFailure(error, flags);
  }
});

cli.option('--json', 'Machine-readable JSON on stdout');
cli.help();

function reportFailure(error: unknown, flags: Flags): void {
  const json = boolFlag(flags.json);
  if (error instanceof VerificationError) {
    if (json) writeJsonReport({ ok: false, verification: error.report });
    process.stderr.write(`[tools-pack] ${error.message}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (json) writeJsonReport({ ok: false, error: message });
    process.stderr.write(`[tools-pack] failed: ${message}\n`);
  }
  process.exitCode = 1;
}

try {
  cli.parse(process.argv, { run: false });
  await cli.runMatchedCommand();
} catch (error) {
  reportFailure(error, { json: process.argv.includes('--json') });
}
