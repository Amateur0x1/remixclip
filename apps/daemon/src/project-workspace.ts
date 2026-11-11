/**
 * [INPUT]: daemon data dir, a project id, and (for reference materialization) the db + project row.
 * [OUTPUT]: The single shared working directory every conversation in that project runs in, plus
 *           the `reference/` folder that holds a local copy of the recreation's source clip.
 * [POS]: Path convention shared by run spawning and artifact/file reads — one definition, so
 *        "the agent wrote here but the preview reads there" cannot drift again.
 *
 * A recreation project ("让 AI 复刻这条") gets its source clip COPIED in, never linked: the
 * library cache is a transient download slot that the user and the downloader delete/replace,
 * while the project is the durable artifact. An agent pointed at a cache path breaks the moment
 * the item is re-downloaded; an agent pointed at `reference/<name>` never does. Copying is cheap
 * on APFS (copyfile clones the extents) and idempotent — same size means it is already done.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Project } from '@remixclip/contracts';
import { findSourceMedia } from './library/media.js';

/** Folder inside the working directory that holds recreation source material. */
export const PROJECT_REFERENCE_DIR = 'reference';

/** Folder beside `reference/` for deliverables: renders, frames, contact sheets. */
export const PROJECT_OUTPUT_DIR = 'output';

export function projectWorkspaceDir(dataDir: string, projectId: string): string {
  return path.join(dataDir, 'projects', projectId);
}

export interface ProjectReferenceFile {
  /** Relative to the working directory, so prompts and the agent never see an absolute path. */
  relPath: string;
  bytes: number;
}

/**
 * Every library item a project recreates, in selection order.
 *
 * `sourceLibraryItemId` is the single-item form older clients send; it is merged in so both
 * shapes reach the copy step without the caller having to care which one it wrote.
 */
export function sourceLibraryItemIds(project: Project | null): string[] {
  const meta = project?.metadata;
  if (!meta) return [];
  const ids = [meta.sourceLibraryItemId, ...(meta.sourceLibraryItemIds ?? [])];
  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/**
 * Copy every source clip of a recreation project into `<cwd>/reference/`.
 *
 * Runs before every turn (cheap: one stat when the copy already exists), because the first turn
 * of a recreation may start before the download finished and the reference must appear as soon
 * as it does. Projects without library items are left untouched — no empty folder in plain chats.
 */
export function materializeProjectReferences(
  db: Database.Database,
  cwd: string,
  project: Project | null,
): ProjectReferenceFile[] {
  const itemIds = sourceLibraryItemIds(project);
  if (!itemIds.length) return [];

  // The folder exists as soon as the chat does: the brief tells the agent to read inside it, and
  // an empty folder is a far better answer than "no such file or directory".
  const dir = path.join(cwd, PROJECT_REFERENCE_DIR);
  mkdirSync(dir, { recursive: true });
  // Deliverables live beside the source, not inside some tool's scaffold directory: the prompt
  // names `output/`, so the folder is there before the first render starts.
  mkdirSync(path.join(cwd, PROJECT_OUTPUT_DIR), { recursive: true });

  const files: ProjectReferenceFile[] = [];
  const used = new Set<string>();
  for (const itemId of itemIds) {
    const media = findSourceMedia(db, itemId);
    if (!media) continue;
    // Two posts can download under the same file name; keep both instead of silently overwriting.
    const name = uniqueName(path.basename(media.path), used);
    used.add(name);
    const target = path.join(dir, name);
    if (!hasSameBytes(target, media.path)) copyFileSync(media.path, target);
    files.push({ relPath: `${PROJECT_REFERENCE_DIR}/${name}`, bytes: statSync(target).size });
  }
  return files;
}

/** `clip.mp4` → `clip-2.mp4` when the name is already taken in this reference folder. */
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let index = 2;
  let candidate = `${stem}-${index}${ext}`;
  while (used.has(candidate)) candidate = `${stem}-${++index}${ext}`;
  return candidate;
}

/** Skip the copy when the reference already holds exactly those bytes. */
function hasSameBytes(target: string, source: string): boolean {
  try {
    return existsSync(target) && statSync(target).size === statSync(source).size;
  } catch {
    return false;
  }
}
