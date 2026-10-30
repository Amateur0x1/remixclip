/**
 * Resolve an agent CLI binary on disk.
 * Precedence (mirrors open-design): *_BIN env override -> PATH walk with
 * common user-toolchain dirs appended.
 */

import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import type { RuntimeAgentDef } from './types.js';

const EXTRA_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  path.join(process.env.HOME ?? '/tmp', '.local', 'bin'),
  path.join(process.env.HOME ?? '/tmp', '.npm-global', 'bin'),
];

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Expand `~/` in app-bundle candidate paths to HOME. */
function expandHome(candidate: string): string {
  if (candidate === '~') return process.env.HOME ?? '/tmp';
  if (candidate.startsWith('~/')) {
    return path.join(process.env.HOME ?? '/tmp', candidate.slice(2));
  }
  return candidate;
}

/** Return the dirs actually searched for binary resolution (for the diagnostic tooltip). */
export function agentSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    ...(env.PATH ?? '').split(path.delimiter),
    ...EXTRA_BIN_DIRS,
  ].filter(Boolean);
}

export function resolveAgentExecutable(
  def: RuntimeAgentDef,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (def.binEnvOverride) {
    const override = env[def.binEnvOverride];
    if (override && isExecutable(override)) return override;
  }

  const searchPath = [
    ...(env.PATH ?? '').split(path.delimiter),
    ...EXTRA_BIN_DIRS,
  ].filter(Boolean);

  const bins = [def.bin, ...(def.fallbackBins ?? [])];
  for (const dir of new Set(searchPath)) {
    for (const bin of bins) {
      const candidate = path.join(dir, bin);
      if (isExecutable(candidate)) return candidate;
    }
  }

  // Last, look for CLIs bundled in app packages: GUI installs like ChatGPT.app don't put codex
  // on PATH, but the bundle ships a directly spawnable native binary (including a shim).
  for (const candidate of def.bundleBins ?? []) {
    const resolved = expandHome(candidate);
    if (isExecutable(resolved)) return resolved;
  }
  return null;
}
