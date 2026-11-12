import type { Express, Request, Response } from 'express';
import { detectAgents } from '../runtimes/detection.js';
import { getQuota } from '../runtimes/quota-state.js';

export function registerAgentsRoutes(app: Express): void {
  // GET /api/agents — detect available local agent CLIs, plus the last known quota reading
  // (observed from real runs — never a paid probe).
  app.get('/api/agents', async (req: Request, res: Response) => {
    try {
      const force = req.query.refresh === '1';
      const agents = (await detectAgents(force)).map((agent) => ({
        ...agent,
        quota: getQuota(agent.id),
      }));
      res.json({ agents });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'agent 探测失败',
      });
    }
  });
}
