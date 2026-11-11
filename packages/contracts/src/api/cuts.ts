/**
 * [INPUT]: One project's finished cut, recorded by the daemon after a run produced
 *          `output/final.mp4` and mirrored into `<projectDir>/.remixclip/manifest.json`.
 * [OUTPUT]: The cut schema plus its list response, shared by the cuts route and 成片库.
 * [POS]: Cross-end contract for the output side of the workspace: 素材库 holds inputs,
 *        成片库 holds one finished cut per project (1:1, project → cut).
 */

import { z } from 'zod';

/**
 * A finished cut. Its identity IS the project id: the table uses project_id as the primary key,
 * so "one project, at most one cut" is a database guarantee rather than a UI convention.
 */
export const projectCutSchema = z.object({
  projectId: z.string(),
  /** Denormalized for the library grid; the project row stays the source of truth. */
  projectName: z.string(),
  /** The project's single conversation, used to read `output/final.mp4` through the file route. */
  conversationId: z.string(),
  /** POSIX path relative to the project working dir, always `output/final.mp4` today. */
  outputPath: z.string(),
  /** The reference clip the cut was made from (first selected material), relative to the cwd. */
  referencePath: z.string().nullable(),
  /** Poster frame extracted next to the cut; null when ffmpeg was unavailable. */
  posterPath: z.string().nullable(),
  size: z.number(),
  durationMs: z.number().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** The run that last produced the cut. */
  runId: z.string().nullable(),
  createdAt: z.number(),
  /** Bumped whenever a newer cut overwrites the previous one. */
  updatedAt: z.number(),
});

export type ProjectCut = z.infer<typeof projectCutSchema>;

export const cutListResponseSchema = z.object({
  cuts: z.array(projectCutSchema),
});

export type CutListResponse = z.infer<typeof cutListResponseSchema>;
