/**
 * Run artifact discovery — a minimal synchronous port of open-design run-artifact-fs.ts.
 *
 * Instead of relying on each agent's tool-call stream (only claude's output shape is
 * recognizable; codex / gemini / hermes all report 0), we diff fingerprint snapshots of the
 * **session working directory** before and after a run — any artifact written by any runtime
 * can be found.
 *
 * Fingerprint: size + mtimeMs, plus sha1 for files ≤1MB (editing an existing artifact doesn't
 * change the file count, so comparison must be by path fingerprint; hashing large files is too
 * expensive, size+mtime suffices).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RunArtifact } from '@remixclip/contracts';

const MAX_FILES = 5000;
const MAX_DEPTH = 8;
const HASH_SIZE_LIMIT = 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules']);

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  sha1?: string;
}

export type WorkspaceSnapshot = Map<string, FileFingerprint>;

/**
 * Recursively scan the working directory, returning relative path (posix) → fingerprint.
 * Skips dot-prefixed entries (naturally excludes .DS_Store etc.).
 */
export function snapshotWorkspace(root: string): WorkspaceSnapshot {
  const out: WorkspaceSnapshot = new Map();
  let count = 0;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || count >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      try {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(abs, entryRel, depth + 1);
        } else if (entry.isFile()) {
          const st = statSync(abs);
          const fp: FileFingerprint = { size: st.size, mtimeMs: st.mtimeMs };
          if (st.size <= HASH_SIZE_LIMIT) {
            fp.sha1 = createHash('sha1').update(readFileSync(abs)).digest('hex');
          }
          out.set(entryRel, fp);
          count += 1;
        }
      } catch {
        // A single file failure doesn't affect the overall scan
      }
    }
  };

  walk(root, '', 0);
  return out;
}

function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.sha1 === b.sha1;
}

/** Created/modified list from before → after (deletions don't count as artifacts; ignored). */
export function diffWorkspaceSnapshots(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): RunArtifact[] {
  const artifacts: RunArtifact[] = [];
  for (const [rel, fp] of after) {
    const prev = before.get(rel);
    if (!prev) {
      artifacts.push({ path: rel, change: 'created', size: fp.size });
    } else if (!sameFingerprint(prev, fp)) {
      artifacts.push({ path: rel, change: 'modified', size: fp.size });
    }
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));
  return artifacts;
}
