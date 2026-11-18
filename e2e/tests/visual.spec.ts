/**
 * [INPUT]: apps/web first screen (all /api/* intercepted by the mocks in this file).
 * [OUTPUT]: Visual baselines: chat workspace (project + conversation list), library skeleton,
 *   library list; behavioral regression coverage for explicit CLI selection and chat gating.
 * [POS]: The fallback for regressions such as skeleton-screen flicker; screenshots are
 *   compared pixel by pixel against e2e/baselines.
 */
import { expect, test, type Page } from '@playwright/test';
import type {
  AgentInfo,
  Conversation,
  DaemonRuntimeInfo,
  LibraryItemSummary,
  LibraryListResponse,
  Project,
} from '@remixclip/contracts';
import { compareWithBaseline } from '../visual/baseline';

/** Fixed timestamp: any "relative time" rendering never shifts with the run time. */
const T0 = 1_700_000_000_000;

const PROJECTS: Project[] = [
  {
    id: 'proj_default',
    name: '默认项目',
    skillId: null,
    designSystemId: null,
    customInstructions: null,
    metadata: { kind: 'chat' },
    createdAt: T0,
    updatedAt: T0,
    conversationCount: 1,
  },
  {
    id: 'proj_bili',
    name: 'B站长视频拆条脚本',
    skillId: null,
    designSystemId: null,
    customInstructions: null,
    metadata: { kind: 'chat' },
    createdAt: T0 - 1,
    updatedAt: T0 - 1,
    conversationCount: 1,
  },
  {
    id: 'proj_douyin',
    name: '抖音探店脚本 · 30 秒',
    skillId: null,
    designSystemId: null,
    customInstructions: null,
    metadata: { kind: 'chat' },
    createdAt: T0 - 2,
    updatedAt: T0 - 2,
    conversationCount: 1,
  },
];

/** 1:1 — every project owns exactly one conversation. */
const CONVERSATIONS: Conversation[] = [
  { id: 'conv-1', title: '小红书爆款标题改写', createdAt: T0, updatedAt: T0, messageCount: 4, projectId: 'proj_default' },
  { id: 'conv-2', title: 'B站长视频拆条脚本', createdAt: T0 - 1, updatedAt: T0 - 1, messageCount: 2, projectId: 'proj_bili' },
  { id: 'conv-3', title: '抖音探店脚本 · 30 秒', createdAt: T0 - 2, updatedAt: T0 - 2, messageCount: 6, projectId: 'proj_douyin' },
];

const AGENTS: AgentInfo[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    available: true,
    version: '1.0.98 (Claude Code)',
    path: '/opt/homebrew/bin/claude',
    binSource: 'path',
    models: ['sonnet', 'opus', 'haiku'],
    capabilities: [
      { id: 'sessionResume', flag: '--resume' },
      { id: 'appendSystemPrompt', flag: '--append-system-prompt' },
      { id: 'permissionMode', flag: '--permission-mode' },
    ],
    auth: { status: 'ok' },
  },
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    available: false,
    error: '未在 PATH 找到 codex',
    docsUrl: 'https://developers.openai.com/codex/',
    diagnostic: {
      severity: 'error',
      message: '未在 PATH 中找到 codex 可执行文件',
      fixActions: [{ kind: 'rescan' }],
    },
  },
];

const LIBRARY_ITEMS: LibraryItemSummary[] = [
  {
    id: 'xhs:6512f0a1',
    platform: 'xhs',
    kind: 'note',
    remoteId: '6512f0a1',
    title: '夏日咖啡探店 · 3 家藏在巷子里的小店',
    desc: '夏天最治愈的三杯手冲',
    author: { name: '豆子不加糖' },
    coverUrl: 'https://sns-img-bd.xhscdn.com/cover-1.jpg',
    images: ['https://sns-img-bd.xhscdn.com/cover-1.jpg'],
    tags: ['咖啡', '探店'],
    metrics: { likes: 12000, collects: 3400, comments: 260, shares: 410 },
    capturedCommentCount: 24,
    importedAt: T0,
    updatedAt: T0,
  },
  {
    id: 'bilibili:BV1xx411c7mD',
    platform: 'bilibili',
    kind: 'note',
    remoteId: 'BV1xx411c7mD',
    title: '一条视频讲透「三秒抓住注意力」的剪辑节奏',
    desc: '',
    author: { name: '剪辑手记' },
    coverUrl: 'https://i0.hdslb.com/cover-2.jpg',
    images: ['https://i0.hdslb.com/cover-2.jpg'],
    tags: ['剪辑'],
    metrics: { likes: 43000, collects: 8900, comments: 1020, shares: 2300 },
    capturedCommentCount: 0,
    importedAt: T0,
    updatedAt: T0,
  },
  {
    id: 'douyin:7300000000000000000',
    platform: 'douyin',
    kind: 'card',
    remoteId: '7300000000000000000',
    title: '夜市小吃的 15 秒开场',
    desc: '',
    coverUrl: 'https://p3-sign.douyinpic.com/cover-3.jpg',
    images: ['https://p3-sign.douyinpic.com/cover-3.jpg'],
    tags: [],
    metrics: { likes: 7800, collects: 0, comments: 0, shares: 0 },
    capturedCommentCount: 0,
    importedAt: T0,
    updatedAt: T0,
  },
];

const RUNTIME_INFO: DaemonRuntimeInfo = {
  pid: 4242,
  port: 7456,
  endpoint: 'http://127.0.0.1:7456',
  webOrigin: 'http://127.0.0.1:7457',
};

const LIBRARY: LibraryListResponse = {
  items: LIBRARY_ITEMS,
  total: LIBRARY_ITEMS.length,
  counts: {
    all: LIBRARY_ITEMS.length,
    xhs: 1,
    bilibili: 1,
    douyin: 1,
    pinterest: 0,
    youtube: 0,
    twitter: 0,
    instagram: 0,
  },
};

/** Covers come from a remote CDN, which must be replaced with deterministic content in visual
 * regression. Three distinct aspect ratios keep the masonry layout inside the baseline. */
const PLACEHOLDER_SIZES = [[30, 40], [36, 30], [40, 30]] as const;

function placeholderSvg(coverUrl: string): string {
  const index = Number(/(\d)\.jpg/.exec(coverUrl)?.[1] ?? 0) % PLACEHOLDER_SIZES.length;
  const [width, height] = PLACEHOLDER_SIZES[index]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#d8d8d8"/></svg>`;
}

interface MockOptions {
  agents?: AgentInfo[];
  /** null = no saved connection; discovery alone must never select a CLI. */
  agentId?: string | null;
  sourceReady?: boolean;
  /** pending = the request hangs forever, to capture the first-frame skeleton. */
  library?: 'loaded' | 'pending';
}

/**
 * A single route handler covers all /api/*: it neither depends on the local daemon
 * nor slips into real data when a mock is missing, which would drift the baselines.
 */
async function mockDaemon(page: Page, options: MockOptions = {}): Promise<void> {
  let config = { agentId: options.agentId === null ? undefined : options.agentId ?? 'claude' };
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    // Conversations only exist under a project: /api/projects/:id/conversations[/:cid/messages].
    // 1:1 means the collection route answers with zero or one conversation, scoped by project.
    const conversationsRoute = /^\/api\/projects\/([^/]+)\/conversations$/.exec(pathname);
    if (conversationsRoute) {
      const projectId = decodeURIComponent(conversationsRoute[1]!);
      return route.fulfill({ json: { conversations: CONVERSATIONS.filter((item) => item.projectId === projectId) } });
    }
    if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages$/.test(pathname)) {
      return route.fulfill({ json: { messages: [] } });
    }
    if (/^\/api\/library\/items\/[^/]+\/shots$/.test(pathname)) {
      return route.fulfill({ json: {
        shots: [], job: null,
        media: options.sourceReady ? {
          id: 'source-1', itemId: LIBRARY_ITEMS[0]!.id, kind: 'source',
          path: '/mock/source.mp4', status: 'ready', progress: 1, createdAt: T0, updatedAt: T0,
        } : null,
      } });
    }
    switch (pathname) {
      case '/api/agents':
        return route.fulfill({ json: { agents: options.agents ?? AGENTS } });
      case '/api/projects':
        return route.fulfill({ json: { projects: PROJECTS } });
      case '/api/app-config':
        if (route.request().method() === 'PUT') config = { ...config, ...route.request().postDataJSON() };
        return route.fulfill({ json: config });
      case '/api/library/downloads':
        return route.fulfill({ json: { downloads: [] } });
      case '/api/system/info':
        // The settings drawer prints the daemon endpoint; without this mock it renders an error.
        return route.fulfill({ json: RUNTIME_INFO });
      case '/api/system/extension':
        // Fixed package metadata keeps the companion row (version · size) out of the error state.
        return route.fulfill({
          json: {
            available: true,
            version: '0.5.2',
            fileName: 'remixclip-companion-0.5.2.zip',
            size: 1_258_291,
            builtAt: '2026-10-01T00:00:00.000Z',
          },
        });
      case '/api/library/items':
        // Do not fulfill: the request stays pending, so the page remains on the skeleton.
        if (options.library === 'pending') return undefined;
        return route.fulfill({ json: LIBRARY });
      case '/api/library/media':
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: placeholderSvg(new URL(route.request().url()).searchParams.get('url') ?? ''),
        });
      default:
        return route.fulfill({ status: 404, json: { error: `not mocked: ${pathname}` } });
    }
  });
}

/** Wait for fonts and one layout pass to settle, and disable all transitions so
 * screenshots are reproducible. */
async function settle(page: Page): Promise<void> {
  await page.addStyleTag({
    content: [
      '*,*::before,*::after{animation:none!important;transition:none!important}',
      'html{caret-color:transparent!important}',
    ].join('\n'),
  });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(120);
}

async function expectVisual(page: Page, name: string): Promise<void> {
  const screenshot = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  const result = compareWithBaseline(name, screenshot);
  expect(result.ok, result.message).toBe(true);
}

test('对话工作台首屏', async ({ page }) => {
  await mockDaemon(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
  await settle(page);
  await expectVisual(page, 'workspace-chat');
});

test('素材库首帧骨架屏', async ({ page }) => {
  await mockDaemon(page, { library: 'pending' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  // The skeleton is one animate-pulse column of placeholders per masonry column; while the
  // request hangs it must stay visible and never flash back to the empty state.
  await expect(page.locator('main .animate-pulse').first()).toBeVisible();
  await settle(page);
  await expectVisual(page, 'library-skeleton');
});

test('素材库列表', async ({ page }) => {
  await mockDaemon(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await expect(page.getByText('夏日咖啡探店 · 3 家藏在巷子里的小店')).toBeVisible();
  await settle(page);
  await expectVisual(page, 'library-list');
});

test('设置页：能力位与未登录提示', async ({ page }) => {
  await mockDaemon(page, {
    agents: [
      {
        ...AGENTS[0]!,
        auth: { status: 'unauthenticated', detail: 'API Error: 401 · Please run /login' },
      },
      AGENTS[1]!,
    ],
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开设置' }).click();
  // Settings replaces the main pane instead of opening an overlay: no dialog is present.
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('未登录').first()).toBeVisible();
  await settle(page);
  await expectVisual(page, 'settings-page');
});

for (const scenario of [
  { label: '未连接', agentId: null },
  { label: '已绑定 CLI 不可用', agentId: 'codex' },
]) {
  test(`CLI 连接：${scenario.label}时禁止已有对话发送`, async ({ page }) => {
    await mockDaemon(page, { agentId: scenario.agentId });
    let runRequests = 0;
    page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/runs') runRequests++; });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '默认项目', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '消息内容' });
    await expect(composer).toBeDisabled();
    await expect(page.getByText('请先连接并选择一个 Agent CLI，再开始对话。', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
    expect(runRequests).toBe(0);
    await page.locator('main').getByRole('button', { name: '连接本地 Agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  });
}

test('CLI 连接：保存失败不得解锁对话', async ({ page }) => {
  await mockDaemon(page, { agentId: null });
  await page.route('**/api/app-config', (route) => route.fulfill({
    status: route.request().method() === 'PUT' ? 500 : 200,
    json: route.request().method() === 'PUT' ? { error: 'save failed' } : {},
  }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
  await page.locator('main').getByRole('button', { name: '连接', exact: true }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByRole('button', { name: '默认项目', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '消息内容' })).toBeDisabled();
});

for (const savedAgentId of [null, 'claude']) {
  test(`CLI 连接：复刻必须手动选择 CLI（已有连接：${savedAgentId ?? '无'}）`, async ({ page }) => {
    await mockDaemon(page, {
      agentId: savedAgentId,
      sourceReady: true,
      agents: [AGENTS[0]!, { ...AGENTS[1]!, available: true, models: ['test-codex-model'] }],
    });
    const mutationRequests: { pathname: string; body: Record<string, unknown> }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' || request.method() === 'PUT') {
        mutationRequests.push({ pathname: new URL(request.url()).pathname, body: request.postDataJSON() });
      }
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '素材库', exact: true }).click();
    await page.getByRole('button', { name: '让 AI 复刻这条' }).first().click();
    const dialog = page.getByRole('dialog');
    const start = dialog.getByRole('button', { name: '开始复刻', exact: true });
    await expect(start).toBeDisabled();
    await expect(dialog.getByRole('combobox')).toHaveText('请选择一个 Agent CLI');
    await dialog.getByRole('textbox').press('Control+Enter');
    expect(mutationRequests).toEqual([]);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: 'Codex', exact: true }).click();
    await expect(start).toBeEnabled();
    await dialog.getByRole('textbox').fill('只复刻前 5 秒');
    await page.route('**/api/projects', (route) => route.fulfill({ json: {
      project: { ...PROJECTS[0]!, id: 'proj_replicate' },
      conversation: { ...CONVERSATIONS[0]!, id: 'conv_replicate', projectId: 'proj_replicate' },
    } }));
    // A deliberate rejection keeps the modal open and proves the selected CLI reaches the run.
    await page.route('**/api/runs', (route) => route.fulfill({ status: 400, json: { error: 'test run rejected' } }));
    await start.click();
    await expect.poll(() => mutationRequests.some((request) => request.pathname === '/api/runs')).toBe(true);
    expect(mutationRequests.find((request) => request.pathname === '/api/app-config')?.body.agentId).toBe('codex');
    expect(mutationRequests.find((request) => request.pathname === '/api/runs')?.body).toMatchObject({
      agentId: 'codex', projectId: 'proj_replicate', conversationId: 'conv_replicate', guidance: '只复刻前 5 秒',
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(start).toBeEnabled();
  });
}

test('CLI 连接：没有可用 CLI 时复刻引导去连接', async ({ page }) => {
  await mockDaemon(page, { agentId: null, agents: [{ ...AGENTS[1]!, available: false }], sourceReady: true });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '默认项目', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await page.getByRole('button', { name: '让 AI 复刻这条' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '开始复刻', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '连接本地 Agent', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
});
