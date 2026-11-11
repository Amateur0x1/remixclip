/**
 * [INPUT]: a build output directory.
 * [OUTPUT]: an exclusive PID lock that refuses concurrent packaging into the same directory.
 * [POS]: Prevents two local/CI packaging runs from writing the same release tree at once.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, type Logger } from './context.js';

interface LockFile {
  pid: number;
  startedAt: string;
  cwd: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireBuildLock(dir: string, logger?: Logger): () => void {
  ensureDir(dir);
  const lockPath = path.join(dir, '.tools-pack.lock');

  if (existsSync(lockPath)) {
    let existing: LockFile | null = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
    } catch {
      existing = null;
    }
    if (existing && typeof existing.pid === 'number' && isAlive(existing.pid)) {
      throw new Error(
        `another packaging run is active (pid ${existing.pid}, started ${existing.startedAt}). ` +
          `Stop it or remove ${lockPath} if the process is gone.`,
      );
    }
    logger?.warn(`removing stale packaging lock at ${lockPath}`);
    rmSync(lockPath, { force: true });
  }

  const payload: LockFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
  };
  writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFile;
      if (current.pid === payload.pid) rmSync(lockPath, { force: true });
    } catch {
      // The lock was already removed; nothing to do.
    }
  };
}
