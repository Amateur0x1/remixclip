/**
 * [INPUT]: the local database, the data dir and every project's `output/final.mp4`.
 * [OUTPUT]: GET /api/cuts — 成片库's single read endpoint, always reconciled with the filesystem.
 * [POS]: daemon's output-library route. A cut is never created through HTTP: it is derived from a
 *        project that rendered one, so this route only lists (and repairs stale index rows).
 */
import type { Express, Request, Response } from 'express';
import type Database from 'better-sqlite3';
import type { CutListResponse } from '@remixclip/contracts';
import { syncAllProjectCuts } from '../project-cuts.js';

export function registerCutRoutes(app: Express, db: Database.Database, dataDir: string): void {
  app.get('/api/cuts', async (_req: Request, res: Response) => {
    try {
      const cuts = await syncAllProjectCuts(db, dataDir);
      const body: CutListResponse = { cuts };
      res.json(body);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '读取成片库失败' });
    }
  });
}
