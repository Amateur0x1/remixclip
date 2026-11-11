/**
 * [INPUT]: a packaged app bundle (or the staging tree) plus the expected version/targets.
 * [OUTPUT]: a fail-closed checklist covering resources, asar metadata, installers, and a bundled-runtime smoke test.
 * [POS]: The gate between "electron-builder exited 0" and "this artifact can be published".
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_NAME,
  archSpellings,
  hostMatches,
  readJson,
  run,
  type Arch,
  type Logger,
  type Platform,
} from './context.js';
import { hasAsarEntry, openAsar, readAsarFile } from './asar.js';
import { installerExtensions, type TargetKind } from './targets.js';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerificationReport {
  ok: boolean;
  platform: Platform;
  arch: Arch;
  version: string;
  appDir: string | null;
  resourcesDir: string | null;
  installers: string[];
  checks: Check[];
}

export class VerificationError extends Error {
  readonly report: VerificationReport;

  constructor(report: VerificationReport) {
    const failed = report.checks.filter((check) => !check.ok).map((check) => check.name);
    super(`verification failed: ${failed.join(', ')}`);
    this.name = 'VerificationError';
    this.report = report;
  }
}

class Checklist {
  readonly checks: Check[] = [];

  add(name: string, ok: boolean, detail?: string): void {
    this.checks.push(detail ? { name, ok, detail } : { name, ok });
  }

  file(name: string, file: string): void {
    this.add(name, existsSync(file), path.basename(file));
  }
}

// ── Layout discovery ───────────────────────────────────────────────────────

function listDirs(root: string, depth: number): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string, remaining: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      found.push(full);
      if (remaining > 1) walk(full, remaining - 1);
    }
  };
  walk(root, depth);
  return found;
}

export function findAppDir(platform: Platform, arch: Arch, releaseDir: string): string | null {
  const dirs = listDirs(releaseDir, 2);

  if (platform === 'mac') {
    const apps = dirs.filter((dir) => dir.endsWith('.app'));
    const exact = apps.find((dir) => dir.includes(`mac-${arch}`));
    return exact ?? apps[0] ?? null;
  }

  const unpacked = dirs.filter((dir) => path.basename(dir).endsWith('-unpacked'));
  if (unpacked.length === 0) return null;
  const archHint = unpacked.find((dir) => dir.includes('arm64') === (arch === 'arm64'));
  return archHint ?? unpacked[0] ?? null;
}

function resourcesDirFor(platform: Platform, appDir: string): string {
  return platform === 'mac'
    ? path.join(appDir, 'Contents', 'Resources')
    : path.join(appDir, 'resources');
}

// ── Individual checks ──────────────────────────────────────────────────────

function checkNodeRuntime(checklist: Checklist, platform: Platform, resourcesDir: string): void {
  const binary = path.join(resourcesDir, 'node', platform === 'win' ? 'node.exe' : path.join('bin', 'node'));
  const ok = existsSync(binary);
  let detail = path.relative(resourcesDir, binary);
  if (ok && platform !== 'win') {
    try {
      const mode = statSync(binary).mode;
      if ((mode & 0o111) === 0) {
        checklist.add('node runtime executable bit', false, `${detail} is not executable`);
        return;
      }
    } catch {
      // existsSync already succeeded; a stat failure will surface below as a failed smoke test.
    }
  }
  checklist.add('node runtime', ok, detail);
}

function checkExtension(checklist: Checklist, resourcesDir: string): void {
  const manifestFile = path.join(resourcesDir, 'extension', 'manifest.json');
  if (!existsSync(manifestFile)) {
    checklist.add('browser companion manifest', false, 'missing extension/manifest.json');
    return;
  }
  try {
    const manifest = readJson<{ manifest_version?: number }>(manifestFile);
    checklist.add(
      'browser companion manifest',
      manifest.manifest_version === 3,
      `manifest_version=${String(manifest.manifest_version)}`,
    );
  } catch (error) {
    checklist.add('browser companion manifest', false, (error as Error).message);
  }
}

function checkAsar(
  checklist: Checklist,
  resourcesDir: string,
  expectedVersion: string,
): void {
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!existsSync(asarPath)) {
    checklist.add('app.asar', false, 'missing app.asar (asar: true expected)');
    return;
  }

  let archive;
  try {
    archive = openAsar(asarPath);
  } catch (error) {
    checklist.add('app.asar', false, (error as Error).message);
    return;
  }

  checklist.add('app.asar', true);
  checklist.add('asar main entry', hasAsarEntry(archive, 'dist/main/index.js'), 'dist/main/index.js');

  const pkgBuffer = readAsarFile(archive, 'package.json');
  if (!pkgBuffer) {
    checklist.add('asar package.json', false);
    return;
  }
  try {
    const pkg = JSON.parse(pkgBuffer.toString('utf8')) as { version?: string; main?: string };
    checklist.add(
      'asar package version',
      pkg.version === expectedVersion,
      `expected ${expectedVersion}, got ${String(pkg.version)}`,
    );
    checklist.add('asar package main', pkg.main === './dist/main/index.js', String(pkg.main));
  } catch (error) {
    checklist.add('asar package.json', false, (error as Error).message);
  }
}

function checkMacVersion(
  checklist: Checklist,
  appDir: string,
  expectedVersion: string,
): void {
  const plist = path.join(appDir, 'Contents', 'Info.plist');
  if (!existsSync(plist)) {
    checklist.add('Info.plist', false);
    return;
  }
  let version: string | null = null;
  try {
    const json = run('plutil', ['-convert', 'json', '-o', '-', plist], { capture: true });
    version = (JSON.parse(json) as { CFBundleShortVersionString?: string }).CFBundleShortVersionString ?? null;
  } catch {
    const raw = readFileSync(plist, 'utf8');
    version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(raw)?.[1] ?? null;
  }
  checklist.add(
    'bundle short version',
    version === expectedVersion,
    `expected ${expectedVersion}, got ${String(version)}`,
  );
}

function checkInstallers(
  checklist: Checklist,
  releaseDir: string,
  platform: Platform,
  arch: Arch,
  version: string,
  targets: TargetKind[],
): string[] {
  const found: string[] = [];
  // electron-builder spells x64 as `x86_64` for the linux AppImage target, so every
  // spelling it may emit has to be accepted instead of a single hard-coded one.
  const spellings = archSpellings(arch);
  for (const extension of installerExtensions(targets)) {
    const candidates = spellings.map((spelling) =>
      path.join(releaseDir, `${PRODUCT_NAME}-${version}-${platform}-${spelling}${extension}`),
    );
    const match = candidates.find((file) => existsSync(file));
    if (match) found.push(match);
    checklist.add(
      `installer ${extension}`,
      Boolean(match),
      match ? path.basename(match) : candidates.map((file) => path.basename(file)).join(' or '),
    );
  }
  return found;
}

/**
 * Exercises the bundled runtime against the bundled native modules. Only runs when the host
 * matches the target; a cross-arch build cannot execute its own payload.
 */
function checkRuntimeSmoke(checklist: Checklist, platform: Platform, arch: Arch, resourcesDir: string): void {
  if (!hostMatches(platform, arch)) {
    checklist.add('bundled runtime smoke', true, 'skipped (cross-arch build)');
    return;
  }

  const nodeBinary = path.join(resourcesDir, 'node', platform === 'win' ? 'node.exe' : path.join('bin', 'node'));
  if (!existsSync(nodeBinary)) {
    checklist.add('bundled runtime smoke', false, 'node runtime missing');
    return;
  }

  const script = [
    "const fs = require('node:fs');",
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "db.exec('create table t(x integer)');",
    "db.prepare('insert into t values (?)').run(1);",
    "if (db.prepare('select count(*) as c from t').get().c !== 1) throw new Error('sqlite round-trip failed');",
    'db.close();',
    "const ffmpeg = require('@ffmpeg-installer/ffmpeg');",
    "if (!fs.existsSync(ffmpeg.path)) throw new Error('ffmpeg binary missing: ' + ffmpeg.path);",
    "const ffprobe = require('@ffprobe-installer/ffprobe');",
    "if (!fs.existsSync(ffprobe.path)) throw new Error('ffprobe binary missing: ' + ffprobe.path);",
    "console.log(process.version + ' smoke-ok');",
  ].join('\n');

  // Passing the snippet via `-e` breaks on Windows: cmd.exe re-parses the quotes and the
  // runtime receives a truncated script. Write it next to the bundled daemon instead, so
  // require() resolves through the packaged node_modules and nothing shell-parses it.
  const scriptFile = path.join(resourcesDir, 'daemon', '.remixclip-smoke.cjs');
  try {
    writeFileSync(scriptFile, script);
    const output = run(nodeBinary, [scriptFile], {
      cwd: path.join(resourcesDir, 'daemon'),
      capture: true,
    });
    checklist.add('bundled runtime smoke', true, output.trim());
  } catch (error) {
    checklist.add('bundled runtime smoke', false, (error as Error).message.split('\n')[0]);
  } finally {
    rmSync(scriptFile, { force: true });
  }
}

/**
 * The agent reads these on demand, so a bundle that lost the library still "works" — it just
 * silently loses every skill. Check the manifest plus the entry skill the catalog names.
 */
function checkSkillLibrary(checklist: Checklist, resourcesDir: string): void {
  const root = path.join(resourcesDir, 'skills');
  checklist.file('skill manifest', path.join(root, 'manifest.json'));
  checklist.file(
    'skill hyperframes-animation',
    path.join(root, 'hyperframes-animation', 'SKILL.md'),
  );
}

/** Validates the staging tree before electron-builder runs, naming the phase that produced the gap. */
export function verifyStage(stageDir: string, platform: Platform): Check[] {
  const checklist = new Checklist();
  const resourcesDir = stageDir;
  checklist.file('daemon entry', path.join(resourcesDir, 'daemon', 'dist', 'cli.js'));
  for (const dependency of ['better-sqlite3', 'express', '@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe']) {
    checklist.file(
      `daemon dependency ${dependency}`,
      path.join(resourcesDir, 'daemon', 'node_modules', ...dependency.split('/'), 'package.json'),
    );
  }
  checklist.file('web export', path.join(resourcesDir, 'web-out', 'index.html'));
  checklist.add(
    'web export assets',
    existsSync(path.join(resourcesDir, 'web-out', '_next')),
    'web-out/_next',
  );
  checkNodeRuntime(checklist, platform, resourcesDir);
  checkExtension(checklist, resourcesDir);
  checkSkillLibrary(checklist, resourcesDir);
  for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
    checklist.file(`license ${name}`, path.join(resourcesDir, 'licenses', name));
  }
  return checklist.checks;
}

export interface VerifyReleaseOptions {
  platform: Platform;
  arch: Arch;
  version: string;
  releaseDir: string;
  stageDir: string;
  targets: TargetKind[];
  expectInstallers: boolean;
  logger: Logger;
  skipSmoke?: boolean;
}

export function verifyRelease(options: VerifyReleaseOptions): VerificationReport {
  const { platform, arch, version, releaseDir, stageDir, targets, expectInstallers, logger, skipSmoke } = options;
  const checklist = new Checklist();

  // Staging is the source of truth for Resources/ contents when it is still on disk.
  if (existsSync(stageDir)) {
    for (const check of verifyStage(stageDir, platform)) checklist.checks.push(check);
  } else {
    checklist.add('staging tree', true, 'not present; skipping stage checks');
  }

  const appDir = findAppDir(platform, arch, releaseDir);
  checklist.add('app bundle', appDir !== null, appDir ? path.relative(releaseDir, appDir) : 'not found');

  let resourcesDir: string | null = null;
  if (appDir) {
    resourcesDir = resourcesDirFor(platform, appDir);
    checklist.add('bundled resources', existsSync(resourcesDir), path.relative(appDir, resourcesDir));

    checkNodeRuntime(checklist, platform, resourcesDir);
    checkExtension(checklist, resourcesDir);
    checkSkillLibrary(checklist, resourcesDir);
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
      checklist.file(`bundled license ${name}`, path.join(resourcesDir, 'licenses', name));
    }
    checklist.file('app icon', path.join(resourcesDir, 'remixclip.png'));
    checklist.add(
      'web export',
      existsSync(path.join(resourcesDir, 'web-out', 'index.html')),
      'web-out/index.html',
    );
    checkAsar(checklist, resourcesDir, version);
    if (platform === 'mac') checkMacVersion(checklist, appDir, version);
    if (skipSmoke) {
      checklist.add('bundled runtime smoke', true, 'skipped (--no-smoke)');
    } else {
      checkRuntimeSmoke(checklist, platform, arch, resourcesDir);
    }
  }

  const installers = expectInstallers ? checkInstallers(checklist, releaseDir, platform, arch, version, targets) : [];
  if (!expectInstallers) {
    checklist.add('installers', true, 'skipped (--to dir)');
  }

  const report: VerificationReport = {
    ok: checklist.checks.every((check) => check.ok),
    platform,
    arch,
    version,
    appDir,
    resourcesDir,
    installers,
    checks: checklist.checks,
  };

  for (const check of report.checks) {
    const mark = check.ok ? 'ok' : 'FAIL';
    logger.info(`  ${mark.padEnd(4)} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }

  return report;
}

export function assertVerified(report: VerificationReport): void {
  if (!report.ok) throw new VerificationError(report);
}
