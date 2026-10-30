/**
 * [INPUT]: apps/web first screen (all /api/* intercepted by the mocks in this file).
 * [OUTPUT]: Visual baselines: chat workspace (project + conversation list), library skeleton,
 *   library list.
 * [POS]: The fallback for regressions such as skeleton-screen flicker; screenshots are
 *   compared pixel by pixel against e2e/baselines.
 */
import { expect, test, type Page } from '@playwright/test';
import type {
  AgentInfo,
  Conversation,
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
    conversationCount: 3,
  },
];

const CONVERSATIONS: Conversation[] = [
  { id: 'conv-1', title: '小红书爆款标题改写', createdAt: T0, updatedAt: T0, messageCount: 4, projectId: 'proj_default' },
  { id: 'conv-2', title: 'B站长视频拆条脚本', createdAt: T0, updatedAt: T0 - 1, messageCount: 2, projectId: 'proj_default' },
  { id: 'conv-3', title: '抖音探店脚本 · 30 秒', createdAt: T0, updatedAt: T0 - 2, messageCount: 6, projectId: 'proj_default' },
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

const LIBRARY: LibraryListResponse = {
  items: LIBRARY_ITEMS,
  total: LIBRARY_ITEMS.length,
  counts: { all: 3, xhs: 1, bilibili: 1, douyin: 1 },
};

/** 1×1 placeholder image: covers come from a remote CDN, which must be replaced with
 * deterministic content in visual regression. */
const PLACEHOLDER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40"><rect width="30" height="40" fill="#d8d8d8"/></svg>';

interface MockOptions {
  agents?: AgentInfo[];
  /** pending = the request hangs forever, to capture the first-frame skeleton. */
  library?: 'loaded' | 'pending';
}

/**
 * A single route handler covers all /api/*: it neither depends on the local daemon
 * nor slips into real data when a mock is missing, which would drift the baselines.
 */
async function mockDaemon(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    // Conversations only exist under a project: /api/projects/:id/conversations[/:cid/messages].
    if (/^\/api\/projects\/[^/]+\/conversations$/.test(pathname)) {
      return route.fulfill({ json: { conversations: CONVERSATIONS } });
    }
    if (/^\/api\/projects\/[^/]+\/conversations\/[^/]+\/messages$/.test(pathname)) {
      return route.fulfill({ json: { messages: [] } });
    }
    switch (pathname) {
      case '/api/agents':
        return route.fulfill({ json: { agents: options.agents ?? AGENTS } });
      case '/api/projects':
        return route.fulfill({ json: { projects: PROJECTS } });
      case '/api/app-config':
        // An agent is connected globally, so the first-run settings drawer stays closed.
        return route.fulfill({ json: { agentId: 'claude' } });
      case '/api/library/items':
        // Do not fulfill: the request stays pending, so the page remains on the skeleton.
        if (options.library === 'pending') return undefined;
        return route.fulfill({ json: LIBRARY });
      case '/api/library/media':
        return route.fulfill({ contentType: 'image/svg+xml', body: PLACEHOLDER_SVG });
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
  await expect(page.getByRole('button', { name: '小红书爆款标题改写', exact: true })).toBeVisible();
  await settle(page);
  await expectVisual(page, 'workspace-chat');
});

test('素材库首帧骨架屏', async ({ page }) => {
  await mockDaemon(page, { library: 'pending' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '小红书爆款标题改写', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  // The skeleton is 12 animate-pulse placeholder cards; while the request hangs it must
  // stay visible and never flash back to the empty state.
  await expect(page.locator('main .animate-pulse').first()).toBeVisible();
  await settle(page);
  await expectVisual(page, 'library-skeleton');
});

test('素材库列表', async ({ page }) => {
  await mockDaemon(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: '小红书爆款标题改写', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '素材库', exact: true }).click();
  await expect(page.getByText('夏日咖啡探店 · 3 家藏在巷子里的小店')).toBeVisible();
  await settle(page);
  await expectVisual(page, 'library-list');
});

test('设置抽屉：能力位与未登录提示', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: '小红书爆款标题改写', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开设置：本地 Agent' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('未登录').first()).toBeVisible();
  await settle(page);
  await expectVisual(page, 'settings-drawer');
});
