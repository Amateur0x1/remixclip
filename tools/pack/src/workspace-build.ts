/**
 * [INPUT]: the pnpm workspace plus the browser companion (an independent pnpm project).
 * [OUTPUT]: compiled packages, the Next static export, and the companion dist consumed by staging.
 * [POS]: Build phase only — it never packages or moves artifacts.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EXTENSION_DIR, WEB_BUILD_DIST_DIR, run, type Logger } from './context.js';

function ensureExtensionDependencies(logger: Logger): void {
  // The companion is a standalone pnpm project with its own lockfile. Without
  // --ignore-workspace pnpm walks up to the monorepo root and installs the root
  // workspace instead, leaving the companion without any dependency.
  if (existsSync(path.join(EXTENSION_DIR, 'node_modules', 'vite'))) return;
  logger.step('installing browser companion dependencies');
  run('pnpm', [
    '--dir',
    EXTENSION_DIR,
    'install',
    '--frozen-lockfile',
    '--ignore-workspace',
    '--prefer-offline',
  ]);
}

export interface BuildWorkspaceOptions {
  logger: Logger;
  skip?: boolean;
}

export function buildWorkspace(options: BuildWorkspaceOptions): void {
  const { logger, skip } = options;
  if (skip) {
    logger.step('skipping workspace build (--skip-build)');
    return;
  }

  logger.step('building workspace packages');
  run('pnpm', ['-r', '--workspace-concurrency=4', '--if-present', 'run', 'build'], {
    logger,
    // Keep packaging away from a running dev server's .next lock; the export still lands in out/.
    env: {
      ...process.env,
      NEXT_DIST_DIR: WEB_BUILD_DIST_DIR,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });

  ensureExtensionDependencies(logger);
  run('pnpm', ['extension:build'], { logger });
}
