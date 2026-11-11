/**
 * [INPUT]: apps/web's Next dev server (all /api/* mocked inside tests) + e2e/tests/*.spec.ts.
 * [OUTPUT]: Playwright run config; screenshot + baseline comparison is delegated to
 *   e2e/visual/baseline.ts (pixelmatch).
 * [POS]: Visual regression entry point. Runs without touching product code:
 *   pnpm visual / pnpm visual:record.
 */
import { defineConfig, devices } from '@playwright/test';
import { SIDECAR_PORTS } from '@remixclip/sidecar-proto';
import { fileURLToPath } from 'node:url';

const E2E_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Same single source as tools-dev: the harness never invents its own port.
const WEB_PORT = Number(process.env.OD_WEB_PORT ?? SIDECAR_PORTS.web);
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './tests',
  outputDir: './.artifacts/test-results',
  // Visual baselines are per-pixel comparisons, so they must run serially with a single
  // worker to keep parallel screenshots from fighting over CPU and jittering the render.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    // Frontend only: page.route intercepts all /api/* in tests, so neither the local
    // daemon nor a real agent is required.
    command: 'pnpm --dir apps/web run dev',
    cwd: REPO_ROOT,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { NEXT_TELEMETRY_DISABLED: '1', PORT: String(WEB_PORT), NEXT_DIST_DIR: '.next-e2e' },
  },
});
