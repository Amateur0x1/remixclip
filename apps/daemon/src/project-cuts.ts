/**
 * [INPUT]: a project's working directory, its finished video (`output/final.mp4`, or the newest
 *          root-level video for projects rendered before the contract existed), and the project row.
 * [OUTPUT]: The durable description of a finished cut — `<projectDir>/.remixclip/manifest.json`
 *           plus one `project_cuts` row (project_id primary key = at most one cut per project).
 * [POS]: The output-side counterpart of `project-workspace.ts` (which owns `reference/`).
 *
 * Why the daemon writes the manifest instead of the agent: the UI must never depend on the agent
 * remembering to emit valid JSON. The render contract only says WHERE the final cut goes
 * (`output/final.mp4`, exactly one); the daemon then stats it, probes it, extracts a poster and
 * records the pair (reference ↔ output) deterministically after every run.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ProjectCut } from '@remixclip/contracts';
import {
  deleteProjectCut,
  getProject,
  getProjectConversation,
  getProjectCut,
  listProjectCuts,
  listProjects,
  upsertProjectCut,
} from './db.js';
import { materializeProjectReferences, PROJECT_OUTPUT_DIR, projectWorkspaceDir } from './project-workspace.js';
import { extractFrame, probeVideo, resolveFfmpeg, type VideoMeta } from './library/ffmpeg.js';

/** The one path that makes a run's output a 成片; anything else in `output/` is just a file. */
export const PROJECT_CUT_REL_PATH = 'output/final.mp4';

/** Poster frame next to the cut; the library grid never decodes a full video for a thumbnail. */
export const PROJECT_POSTER_REL_PATH = 'output/final.poster.jpg';

/** Video extensions a legacy `output/` root file may have; only the newest one is adopted. */
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm']);

/**
 * Where this project's cut lives.
 *
 * Canonical is `output/final.mp4` (what the prompt mandates). Projects rendered before that
 * contract existed have some other name in `output/`; adopting the newest root-level video keeps
 * them visible in 成片库 without renaming or copying the user's file. The next render that writes
 * `output/final.mp4` naturally supersedes it.
 */
function findProjectCut(cwd: string): { relPath: string; abs: string } | null {
  const canonical = path.join(cwd, PROJECT_CUT_REL_PATH);
  if (existsSync(canonical)) return { relPath: PROJECT_CUT_REL_PATH, abs: canonical };

  const outputDir = path.join(cwd, PROJECT_OUTPUT_DIR);
  if (!existsSync(outputDir)) return null;
  const candidates = readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, mtimeMs: statSync(path.join(outputDir, entry.name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates.length === 0) return null;
  return { relPath: `${PROJECT_OUTPUT_DIR}/${candidates[0].name}`, abs: path.join(outputDir, candidates[0].name) };
}

/** Human-readable descriptor of the pair; hidden so it never shows up in the file tree. */
export const PROJECT_MANIFEST_REL_PATH = '.remixclip/manifest.json';

interface CutManifest {
  version: 1;
  projectId: string;
  projectName: string;
  conversationId: string;
  /** Every source clip, project-relative; the first one is the comparison reference. */
  references: string[];
  output: {
    path: string;
    size: number;
    durationMs: number | null;
    width: number | null;
    height: number | null;
    mtimeMs: number;
  };
  poster: string | null;
  runId: string | null;
  updatedAt: number;
}

function writeManifest(cwd: string, manifest: CutManifest): void {
  const target = path.join(cwd, PROJECT_MANIFEST_REL_PATH);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // rename is atomic on the same volume: a reader never sees a half-written manifest.
  renameSync(tmp, target);
}

/**
 * Reconcile one project's cut with what is on disk.
 *
 * - `output/final.mp4` missing → the project simply has no cut; a stale row is removed.
 * - present → probe it, refresh the poster when the film changed, rewrite the manifest, upsert.
 *
 * Returns null when the project has no cut (or no project / conversation at all).
 */
export async function syncProjectCut(
  db: Database.Database,
  dataDir: string,
  projectId: string,
  runId: string | null = null,
): Promise<ProjectCut | null> {
  const project = getProject(db, projectId);
  if (!project) return null;
  const cwd = projectWorkspaceDir(dataDir, projectId);
  const cut = findProjectCut(cwd);
  if (!cut) {
    if (getProjectCut(db, projectId)) deleteProjectCut(db, projectId);
    return null;
  }

  const stats = statSync(cut.abs);
  let meta: VideoMeta = {};
  try {
    meta = await probeVideo(cut.abs);
  } catch {
    // Metadata is a nicety: a cut with no duration still belongs in 成片库 by size alone.
  }

  // The poster is derived, not authored: refresh it only when the film is newer.
  const posterAbs = path.join(cwd, PROJECT_POSTER_REL_PATH);
  let poster: string | null = existsSync(posterAbs) ? PROJECT_POSTER_REL_PATH : null;
  if (resolveFfmpeg()) {
    const stale = !poster || statSync(posterAbs).mtimeMs < stats.mtimeMs;
    if (stale) {
      try {
        const atMs = Math.min(1000, Math.round((meta.durationMs ?? 0) / 3));
        await extractFrame({ input: cut.abs, atMs, output: posterAbs, quality: 3 });
        poster = PROJECT_POSTER_REL_PATH;
      } catch {
        // Keep whatever poster was already there; a missing thumbnail is not a failed cut.
      }
    }
  }

  // Same helper the run route uses: idempotent, and it returns the project-relative names the
  // manifest should quote (two posts can download under the same basename).
  const references = materializeProjectReferences(db, cwd, project);
  const conversation = getProjectConversation(db, projectId);
  const updatedAt = Date.now();

  if (conversation) {
    writeManifest(cwd, {
      version: 1,
      projectId,
      projectName: project.name,
      conversationId: conversation.id,
      references: references.map((file) => file.relPath),
      output: {
        path: cut.relPath,
        size: stats.size,
        durationMs: meta.durationMs ?? null,
        width: meta.width ?? null,
        height: meta.height ?? null,
        mtimeMs: stats.mtimeMs,
      },
      poster,
      runId,
      updatedAt,
    });

    return upsertProjectCut(db, {
      projectId,
      conversationId: conversation.id,
      runId,
      outputPath: cut.relPath,
      referencePath: references[0]?.relPath ?? null,
      posterPath: poster,
      size: stats.size,
      durationMs: meta.durationMs ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      updatedAt,
    });
  }
  return null;
}

/**
 * Bring the index in line with the filesystem, then return every cut.
 *
 * Projects made before this feature (or while the daemon was off) already have `output/final.mp4`
 * on disk but no row; discovery here means 成片库 is never empty just because nobody re-rendered.
 */
export async function syncAllProjectCuts(db: Database.Database, dataDir: string): Promise<ProjectCut[]> {
  for (const cut of listProjectCuts(db)) {
    const abs = path.join(projectWorkspaceDir(dataDir, cut.projectId), cut.outputPath);
    if (!existsSync(abs)) deleteProjectCut(db, cut.projectId);
  }
  for (const project of listProjects(db)) {
    const cut = findProjectCut(projectWorkspaceDir(dataDir, project.id));
    if (!cut) continue;
    const existing = getProjectCut(db, project.id);
    // Path + size is enough of a fingerprint here: renders overwrite the file, they do not reuse it.
    if (existing && existing.outputPath === cut.relPath && existing.size === statSync(cut.abs).size) continue;
    await syncProjectCut(db, dataDir, project.id);
  }
  return listProjectCuts(db);
}
