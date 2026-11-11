import type { Express, Request, Response } from 'express';
import { readAppConfig, writeAppConfig, type AppConfigPrefs } from '../app-config.js';

export function registerAppConfigRoutes(app: Express): void {
  // GET /api/app-config — read user config (agent selection, model, agentCliEnv)
  app.get('/api/app-config', (_req: Request, res: Response) => {
    res.json(readAppConfig());
  });

  // PUT /api/app-config — partial update
  app.put('/api/app-config', (req: Request, res: Response) => {
    const body = req.body as Partial<AppConfigPrefs> | undefined;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ error: '请求体必须是 JSON 对象' });
      return;
    }
    const patch: Partial<AppConfigPrefs> = {};
    if (typeof body.agentId === 'string') patch.agentId = body.agentId;
    if (body.agentModels && typeof body.agentModels === 'object') {
      patch.agentModels = body.agentModels;
    }
    if (body.agentCliEnv && typeof body.agentCliEnv === 'object') {
      patch.agentCliEnv = body.agentCliEnv;
    }
    res.json(writeAppConfig(patch));
  });
}
