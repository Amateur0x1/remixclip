#!/usr/bin/env node
/**
 * [INPUT]: the caller's argv plus the tool's own source tree.
 * [OUTPUT]: a fresh dist build (only when sources are newer) and the tools-pack CLI.
 * [POS]: Bin entry so `pnpm exec tools-pack` works from a fresh clone without a manual build step.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(toolRoot, 'dist', 'index.js');
const sourceRoot = path.join(toolRoot, 'src');

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full));
    } else if (entry.isFile()) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function ensureFreshBuild() {
  if (!existsSync(sourceRoot)) return;
  if (existsSync(distEntry) && statSync(distEntry).mtimeMs >= newestMtime(sourceRoot)) return;
  const result = spawnSync('pnpm', ['--filter', '@remixclip/tools-pack', 'build'], {
    cwd: toolRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

ensureFreshBuild();
await import(pathToFileURL(distEntry).href);
