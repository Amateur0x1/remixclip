/**
 * [INPUT]: the built browser companion directory (env-provided or the repo layout) and its files.
 * [OUTPUT]: /api/system/extension (build metadata) and /api/system/extension/package (zip bytes).
 * [POS]: daemon-side distribution of the RemixClip companion, so the library's download button
 *        never needs the user to locate a path inside the repository.
 *
 * The daemon owns this instead of the web bundle because both surfaces talk to the same origin:
 * in dev Next proxies /api/* here, and a packaged build serves the web UI from this same server.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionPackageInfo } from '@remixclip/contracts';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';
import type { Express, Request, Response } from 'express';
import { createZip, type ZipEntry } from '../zip.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Archive/file prefix; also the folder name users see after unzipping. */
const PACKAGE_NAME = 'remixclip-companion';

/**
 * Where the built companion lives, in priority order:
 * - `OD_EXTENSION_DIR` — the launcher (tools-dev) or a packaged bundle names it explicitly;
 * - the repo layout, resolved from this file (apps/daemon/dist/routes → repo root);
 * - the process cwd, for `node apps/daemon/dist/cli.js` run from the repo root by hand.
 */
function resolveExtensionDir(): string | null {
  const candidates = [
    process.env[SIDECAR_ENV.EXTENSION_DIR],
    path.resolve(__dirname, '../../../../extensions/remixclip-companion/dist'),
    path.resolve(process.cwd(), 'extensions/remixclip-companion/dist'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  return null;
}

/** Recursive file list in stable order, skipping editor/OS droppings and directories. */
function collectEntries(dir: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const walk = (current: string, prefix: string) => {
    const names = readdirSync(current).sort();
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const absolute = path.join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (stat.isFile()) {
        entries.push({ name: relative, data: readFileSync(absolute), mtime: stat.mtime });
      }
    }
  };
  walk(dir, '');
  return entries;
}

/** The build's own version, so a stale zip is obvious from its file name. */
function readVersion(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

interface BuiltPackage {
  info: ExtensionPackageInfo;
  zip: Buffer;
}

/**
 * Assemble the archive on demand. The companion build is a few hundred kilobytes, so this
 * stays well under a frame of UI latency and never caches a package the user just rebuilt.
 */
function buildPackage(dir: string): BuiltPackage {
  const entries = collectEntries(dir);
  const zip = createZip(entries);
  const version = readVersion(dir);
  const builtAt = entries.reduce<number>((newest, entry) => {
    const time = entry.mtime?.getTime() ?? 0;
    return time > newest ? time : newest;
  }, 0);
  return {
    info: {
      available: entries.length > 0,
      version,
      fileName: `${PACKAGE_NAME}-${version ?? 'latest'}.zip`,
      size: zip.length,
      builtAt: builtAt > 0 ? new Date(builtAt).toISOString() : null,
    },
    zip,
  };
}

export function registerExtensionRoutes(app: Express): void {
  // Metadata first, so the dialog can say "build it first" instead of offering a dead button.
  app.get('/api/system/extension', (_req: Request, res: Response) => {
    const dir = resolveExtensionDir();
    if (!dir) {
      const info: ExtensionPackageInfo = {
        available: false,
        version: null,
        fileName: null,
        size: null,
        builtAt: null,
      };
      res.json(info);
      return;
    }
    res.json(buildPackage(dir).info);
  });

  app.get('/api/system/extension/package', (_req: Request, res: Response) => {
    const dir = resolveExtensionDir();
    if (!dir) {
      res.status(404).json({
        error: 'the browser companion has not been built yet',
        hint: 'run pnpm extension:build, then try the download again',
      });
      return;
    }
    const { info, zip } = buildPackage(dir);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${info.fileName}"`);
    res.setHeader('Content-Length', String(zip.length));
    // A rebuild must never be shadowed by an older copy in the browser cache.
    res.setHeader('Cache-Control', 'no-store');
    res.end(zip);
  });
}
