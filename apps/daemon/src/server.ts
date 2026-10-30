import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import { DATA_DIR_NAME } from '@remixclip/brand';
import { SIDECAR_ENV } from '@remixclip/sidecar-proto';
import type Database from 'better-sqlite3';
import { registerAgentsRoutes } from './routes/agents.js';
import { registerConnectionTestRoutes } from './routes/connection.js';
import { registerRunsRoutes } from './routes/runs.js';
import { registerConversationRoutes } from './routes/conversations.js';
import { registerAppConfigRoutes } from './routes/app-config.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerLibraryRoutes } from './routes/library.js';
import { openDatabase, getDefaultDbPath } from './db.js';
import { initAppConfig } from './app-config.js';
import { RunManager } from './runtimes/runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface RemixclipServeOptions {
  port: number;
  webDistDir?: string;
  dataDir?: string;
}

export function createRemixclipApp(
  dataDir: string | undefined,
  db: Database.Database,
  options: { webDistDir?: string } = {},
): Express {
  const app = express();

  // JSON body parsing (supports pasted screenshots and file attachment uploads)
  app.use(express.json({ limit: '32mb' }));

  // Only accept browser requests from same-origin or the local web dev server; arbitrary
  // pages must not be able to authorize directories / start agents.
  // Browser extensions may access only the library namespace (pairing + import + media);
  // all other APIs are still rejected.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.get('origin');
    if (origin) {
      if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
        if (!req.path.startsWith('/api/library')) {
          res.status(403).json({ error: '扩展只能访问素材库接口' });
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Remixclip-Token');
        if (req.method === 'OPTIONS') { res.status(204).end(); return; }
        next();
        return;
      }
      let url: URL;
      try { url = new URL(origin); } catch { res.status(403).json({ error: '非法请求来源' }); return; }
      const host = req.hostname;
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
          !['127.0.0.1', 'localhost'].includes(host) ||
          ![String(req.socket.localPort), '7457'].includes(url.port)) {
        res.status(403).json({ error: '不允许跨站访问本地服务' });
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Remixclip-Token');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  // Health check
  app.get('/api/', (_req2: Request, res: Response) => {
    res.json({ status: 'ok', version: '0.1.0' });
  });

  // Register routes
  const artifactsDir = dataDir
    ? path.join(dataDir, 'artifacts')
    : path.join(__dirname, '..', '..', DATA_DIR_NAME, 'artifacts');

  if (!existsSync(artifactsDir)) {
    mkdirSync(artifactsDir, { recursive: true });
  }

  // Local agent runtime (open-design runs protocol)
  const runManager = new RunManager();
  registerAgentsRoutes(app);
  registerConnectionTestRoutes(app);
  registerRunsRoutes(app, runManager, db, dataDir ?? path.join(__dirname, '..', '..', DATA_DIR_NAME));
  registerWorkspaceRoutes(app, dataDir ?? path.join(__dirname, '..', '..', DATA_DIR_NAME), db);
  registerSystemRoutes(app);
  registerConversationRoutes(app, db, runManager);
  registerAppConfigRoutes(app);
  registerProjectRoutes(app, db, dataDir ?? path.join(__dirname, '..', '..', DATA_DIR_NAME), runManager);
  registerLibraryRoutes(app, dataDir ?? path.join(__dirname, '..', '..', DATA_DIR_NAME), db);

  // Static file serving for artifacts
  app.use('/artifacts', express.static(artifactsDir));

  // Unknown /api/* must 404 as JSON — never fall through to the SPA shell
  // (otherwise frontend fetch gets index.html and reports "Unexpected token '<'").
  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'not found' });
  });

  // Serve static frontend — resolve the web UI directory in priority order:
  //   1. explicit option (CLI --web-dist / packaged resource dir)
  //   2. OD_WEB_DIST_DIR env (injected by sidecar / desktop at spawn time)
  //   3. repo-relative fallback (dev layout: apps/daemon/dist → apps/web/out)
  // Packaged builds invalidate 3, so 1 / 2 are the official entry points when packaged.
  const explicitWebDistDir = options.webDistDir ?? process.env[SIDECAR_ENV.WEB_DIST_DIR];
  const webOutDir = explicitWebDistDir
    ? path.resolve(explicitWebDistDir)
    : path.join(__dirname, '..', '..', 'web', 'out');
  const staticDir = existsSync(path.join(webOutDir, 'index.html')) ? webOutDir : null;
  if (staticDir) {
    console.log(
      `[remixclip] serving web UI from ${staticDir}${explicitWebDistDir ? ' (explicit web dist dir)' : ''}`,
    );
    app.use(express.static(staticDir));
    // SPA fallback — Express 5 requires explicit path pattern
    app.get('/{*splat}', (_req: Request, res: Response) => {
      const indexPath = path.join(staticDir, 'index.html');
      if (existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).json({ error: 'not found' });
      }
    });
  } else {
    // When a directory is explicitly specified but has no index.html, warn clearly
    // (helps with packaged-build troubleshooting).
    if (explicitWebDistDir) {
      console.warn(
        `[remixclip] web dist dir ${webOutDir} has no index.html; web UI will be unavailable`,
      );
    }
    // No frontend — just API
    app.get('/{*splat}', (_req: Request, res: Response) => {
      res.json({ message: 'RemixClip daemon — use /api/* endpoints' });
    });
  }

  return app;
}

export async function startRemixclipServer(options: RemixclipServeOptions): Promise<{
  app: Express;
  server: ReturnType<typeof express.application.listen>;
}> {
  const dataDir = options.dataDir || path.join(__dirname, '..', '..', DATA_DIR_NAME);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Initialize database
  const dbPath = getDefaultDbPath(dataDir);
  const remixclipDb = openDatabase(dbPath);
  console.log(`[remixclip] database at ${dbPath}`);

  // Initialize app config store
  initAppConfig(dataDir);
  // Startup precheck: make sure the workspaces directory exists.
  const workspacesDir = path.join(dataDir, 'workspaces');
  if (!existsSync(workspacesDir)) {
    mkdirSync(workspacesDir, { recursive: true });
  }

  // Store db on app for routes
  const app = createRemixclipApp(dataDir, remixclipDb.db, { webDistDir: options.webDistDir });
  app.locals.db = remixclipDb.db;

  return new Promise((resolve, reject) => {
    const server = app.listen(options.port, '127.0.0.1', () => {
      console.log(`[remixclip] daemon listening on http://127.0.0.1:${options.port}`);
      resolve({ app, server });
    });
    server.on('error', (err: Error) => {
      console.error(`[remixclip] server error: ${err.message}`);
      reject(err);
    });
  });
}