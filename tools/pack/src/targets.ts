/**
 * [INPUT]: a platform, an optional `--to` list, and the packaging flags.
 * [OUTPUT]: a validated electron-builder argument plan (targets, compression, signing, output dir).
 * [POS]: The only place that translates RemixClip's `--to` vocabulary into electron-builder flags.
 */
import type { Platform, Arch } from './context.js';

export type TargetKind = 'dir' | 'dmg' | 'zip' | 'nsis' | 'appimage';

export const PLATFORM_TARGETS: Record<Platform, TargetKind[]> = {
  mac: ['dmg', 'zip'],
  win: ['nsis'],
  linux: ['appimage'],
};

const ELECTRON_TARGET_NAME: Record<Exclude<TargetKind, 'dir'>, string> = {
  dmg: 'dmg',
  zip: 'zip',
  nsis: 'nsis',
  appimage: 'AppImage',
};

export function parseTargets(platform: Platform, to: unknown): TargetKind[] {
  const allowed = new Set<TargetKind>([...PLATFORM_TARGETS[platform], 'dir']);
  const raw = typeof to === 'string' && to.trim().length > 0 ? to.trim() : 'all';

  if (raw === 'all') return [...PLATFORM_TARGETS[platform]];

  const requested = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((entry) => entry.toLowerCase());

  const targets: TargetKind[] = [];
  for (const entry of requested) {
    if (entry === 'all') {
      for (const target of PLATFORM_TARGETS[platform]) {
        if (!targets.includes(target)) targets.push(target);
      }
      continue;
    }
    if (!allowed.has(entry as TargetKind)) {
      throw new Error(
        `target "${entry}" is not valid for ${platform}; expected ${[...allowed].join(', ')} or all`,
      );
    }
    if (!targets.includes(entry as TargetKind)) targets.push(entry as TargetKind);
  }

  if (targets.length === 0) {
    throw new Error(`no packaging targets selected for ${platform}`);
  }
  if (targets.includes('dir') && targets.length > 1) {
    throw new Error('target "dir" cannot be combined with installer targets');
  }
  return targets;
}

export interface BuilderPlanOptions {
  platform: Platform;
  arch: Arch;
  targets: TargetKind[];
  version: string;
  releaseDir: string;
  publish: string;
  compression?: string;
  signed: boolean;
  notarize: boolean;
}

export interface BuilderPlan {
  /** Arguments passed to `pnpm` (starting with `exec`). */
  args: string[];
  dirOnly: boolean;
  targets: TargetKind[];
}

export function planBuilder(options: BuilderPlanOptions): BuilderPlan {
  const { platform, arch, targets, version, releaseDir, publish, compression } = options;
  const dirOnly = targets.length === 1 && targets[0] === 'dir';

  const args = [
    'exec',
    'electron-builder',
    '--config',
    'electron-builder.yml',
    '--publish',
    publish,
    `--config.extraMetadata.version=${version}`,
    // Always absolute: the tool may write outside apps/desktop/release.
    `--config.directories.output=${releaseDir}`,
  ];

  if (compression) args.push(`--config.compression=${compression}`);

  const archFlag = `--${arch}`;
  if (dirOnly) {
    args.push('--dir', `--${platform}`, archFlag);
  } else {
    const electronTargets = targets
      .filter((target): target is Exclude<TargetKind, 'dir'> => target !== 'dir')
      .map((target) => ELECTRON_TARGET_NAME[target]);
    args.push(`--${platform}`, ...electronTargets, archFlag);
  }

  if (platform === 'mac') {
    args.push(`--config.mac.notarize=${options.notarize ? 'true' : 'false'}`);
  }

  return { args, dirOnly, targets };
}

/** Installer extensions produced by a target, used by verification and collection. */
export function installerExtensions(targets: TargetKind[]): string[] {
  const extensions = new Set<string>();
  for (const target of targets) {
    if (target === 'dmg') extensions.add('.dmg');
    if (target === 'zip') extensions.add('.zip');
    if (target === 'nsis') extensions.add('.exe');
    if (target === 'appimage') extensions.add('.AppImage');
  }
  return [...extensions];
}
