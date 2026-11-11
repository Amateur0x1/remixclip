/**
 * [INPUT]: GET /api/cuts (成片库's reconciled list of project cuts).
 * [OUTPUT]: Typed cut records for the library grid.
 * [POS]: Web-side access to the output library; cuts are produced by projects, never created here.
 */
import type { CutListResponse, ProjectCut } from '@remixclip/contracts';

export async function listCuts(): Promise<ProjectCut[]> {
  const res = await fetch('/api/cuts', { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as CutListResponse;
  return data.cuts;
}
