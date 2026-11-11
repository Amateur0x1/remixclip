/**
 * [INPUT]: a staged resources tree plus target/signing decisions.
 * [OUTPUT]: installers and unpacked app bundles written to the release directory.
 * [POS]: The only place that shells out to electron-builder; staging and verification stay independent.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DESKTOP_DIR, PRODUCT_NAME, archSpellings, run, type Arch, type Logger, type Platform } from './context.js';
import { planBuilder, type TargetKind } from './targets.js';

export type SignMode = 'auto' | 'always' | 'never';

export interface SigningPlan {
  signed: boolean;
  notarize: boolean;
}

export function parseSignMode(value: unknown): SignMode {
  if (value === undefined || value === true) return value === true ? 'always' : 'auto';
  const normalized = String(value).toLowerCase();
  if (normalized === 'auto' || normalized === 'always' || normalized === 'never') {
    return normalized;
  }
  throw new Error(`invalid --sign "${value}"; expected auto, always or never`);
}

/**
 * `auto` signs when a certificate is exposed through CSC_LINK/CSC_NAME (the GitHub Actions
 * convention) and stays unsigned otherwise, so local builds never block on a missing identity.
 */
export function resolveSigning(platform: Platform, mode: SignMode, notarizeRequested: boolean, logger: Logger): SigningPlan {
  const hasCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

  if (platform !== 'mac') {
    if (notarizeRequested) throw new Error('--notarize is only supported for mac builds');
    if (mode === 'always' && !hasCertificate) {
      throw new Error('--sign always requires CSC_LINK or CSC_NAME');
    }
    return { signed: mode === 'never' ? false : hasCertificate, notarize: false };
  }

  if (mode === 'always' && !hasCertificate) {
    throw new Error('--sign always requires CSC_LINK or CSC_NAME');
  }

  const signed = mode === 'never' ? false : hasCertificate;
  if (!signed) {
    if (mode === 'auto') logger.info('no signing certificate found; producing an unsigned build');
    if (notarizeRequested) {
      throw new Error('--notarize requires a signing certificate (CSC_LINK/CSC_NAME)');
    }
    return { signed: false, notarize: false };
  }

  if (notarizeRequested) {
    const missing = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].filter(
      (key) => !process.env[key],
    );
    if (missing.length > 0) {
      throw new Error(`--notarize requires ${missing.join(', ')}`);
    }
  }

  return { signed, notarize: notarizeRequested };
}

/**
 * Deletes installers (and their blockmaps) from a previous run for the same platform/arch so
 * collection cannot mix versions. Manifests and checksum files are intentionally left alone.
 */
export function cleanPlatformArtifacts(releaseDir: string, platform: Platform, arch: Arch): string[] {
  if (!existsSync(releaseDir)) return [];
  const removed: string[] = [];
  const markers = archSpellings(arch).map((spelling) => `-${platform}-${spelling}.`);
  for (const entry of readdirSync(releaseDir)) {
    if (!entry.startsWith(`${PRODUCT_NAME}-`)) continue;
    if (!markers.some((marker) => entry.includes(marker))) continue;
    rmSync(path.join(releaseDir, entry), { force: true });
    removed.push(entry);
  }
  return removed;
}

export interface PackageAppOptions {
  platform: Platform;
  arch: Arch;
  targets: TargetKind[];
  version: string;
  releaseDir: string;
  publish: string;
  compression?: string;
  signing: SigningPlan;
  logger: Logger;
}

export interface PackageAppResult {
  dirOnly: boolean;
  signed: boolean;
  targets: TargetKind[];
}

export function packageApp(options: PackageAppOptions): PackageAppResult {
  const { platform, arch, targets, version, releaseDir, publish, compression, signing, logger } = options;

  const plan = planBuilder({
    platform,
    arch,
    targets,
    version,
    releaseDir,
    publish,
    compression,
    signed: signing.signed,
    notarize: signing.notarize,
  });

  // Installer builds must not mix files from a previous version; a `--to dir` smoke build
  // deliberately leaves existing installers untouched.
  if (!plan.dirOnly) {
    const removed = cleanPlatformArtifacts(releaseDir, platform, arch);
    if (removed.length > 0) {
      logger.step(`removed ${removed.length} stale ${platform}-${arch} artifact(s)`);
    }
  }

  logger.step(
    `packaging ${PRODUCT_NAME} ${version} (${platform}/${arch}) → ${targets.join(', ')}` +
      (signing.signed ? ' · signed' : ' · unsigned') +
      (signing.notarize ? ' · notarized' : ''),
  );

  run('pnpm', plan.args, {
    cwd: DESKTOP_DIR,
    logger,
    env: {
      ...process.env,
      // Never let electron-builder pick up an unrelated keychain identity for unsigned runs.
      CSC_IDENTITY_AUTO_DISCOVERY: signing.signed ? 'true' : 'false',
    },
  });

  return { dirOnly: plan.dirOnly, signed: signing.signed, targets: plan.targets };
}
