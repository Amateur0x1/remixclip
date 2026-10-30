# RemixClip

**语言：** [English](README.md) · 简体中文

本地优先的创作工作台。它探测你本机已安装的 agent CLI（claude / codex / gemini / kimi / qwen / hermes / opencode / pi 等），在裸 runtime 之上提供项目、对话与素材的组织能力；浏览器插件负责把小红书 / B站 / 抖音的内容推进本地素材库。

> **状态：** 架构仍在演进，**暂不接受代码贡献**，原因见 [CONTRIBUTING.md](CONTRIBUTING.md)。
>
> 架构很大程度参考 [Open Design](https://github.com/Amateur0x1/open-design)，部分实现直接移植自该项目。两者均以 Apache-2.0 授权，移植部分保持同一协议；完整归属声明见 [NOTICE](NOTICE)。

## 组成

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| daemon | `apps/daemon` | 唯一后端、唯一数据源：HTTP API、SQLite、Agent 子进程、素材与媒体处理 |
| web | `apps/web` | Next.js UI（静态导出；开发时走 dev server 热更新） |
| desktop | `apps/desktop` | Electron 薄壳：只负责窗口，打包后负责拉起 daemon |
| companion 扩展 | `extensions/remixclip-companion` | 浏览器侧边栏：采集内容 → 推送到素材库 |
| contracts | `packages/contracts` | 前后端共享的 API 类型，唯一协议来源 |

## 核心模型

- **Project**：容器。有名字、自定义指令、工作目录；删除项目会先取消其中运行中的任务，再级联删除会话与产物。
- **Conversation**：严格属于一个 Project（`project_id NOT NULL`），不可跨项目移动；新建项目自带一个种子会话。
- **Run**：一轮 agent 执行。`POST /api/runs` 创建，事件以 SSE 推送，支持 `?after=<seq>` 断线重放。
- **Library item**：素材库条目（平台 / 作者 / 封面 / 原始 payload）+ 本地媒体、抽帧、对比与渲染结果。
- **App config**：全局偏好（当前 agent、每 agent 的模型、每 agent 的 CLI 环境变量白名单）。

没有「Agent 档案（AgentProfile）」这一层：选哪个 runtime、用哪个模型由全局 app-config 决定；会话只记录自己的 runtime 与工作目录。

## 架构

```
Electron 壳 ──┐                          ┌── Companion 扩展（side panel）
              │ 加载 UI                  │   POST /api/library/import
              ▼                          ▼
        web UI (Next.js) ── HTTP + SSE ── daemon (Express, 127.0.0.1:7456)
                                            ├── SQLite（projects / conversations / messages）
                                            ├── library/（items / media / shots / comparisons）
                                            └── runtimes/ → spawn 本机 agent CLI
```

一条铁律：**daemon 是唯一数据源**。web、Electron、扩展都只是客户端，不各自持有数据副本。

一轮 run 的流程：

1. UI 把消息（可选附件与 UI locale）POST 到 `/api/runs`；
2. daemon 取全局 agent，校验会话确实属于声明的项目，并拒绝同一会话的并发 run；
3. 组装 prompt，在一个事务里写 conversation / user message / run 记录，然后按 runtime 把 prompt 走 stdin、临时文件或 ACP 启动 CLI；
4. 子进程输出逐行解析成带 `seq` 的类型化事件，广播给 `GET /api/runs/:id/events`；
5. 终态时把 assistant 全文、artifacts 和上游 session 句柄落库，下一轮可 resume。

素材库管线：

```
扩展导入 → library_items + batch
  → download（ffmpeg）→ media_files
  → analyze（ffmpeg） → shots
  → renders（上传）   → comparisons（像素对比）
```

抽帧与对比只读本地文件：社交平台视频地址有防盗链且会过期，必须先落地。

## 目录结构

```
apps/
  daemon/            HTTP 路由、run 生命周期、runtime spawn、素材与媒体处理
    src/routes/      projects / conversations / runs / library / agents / system
    src/runtimes/    runtime 注册表、可执行文件解析、进程与事件解析
    src/library/     存储、下载队列、ffmpeg 抽帧、渲染、对比
  web/               聊天 + 素材库 UI（components/workspace、components/library、i18n）
  desktop/           Electron 壳
  packaged/          打包入口
extensions/
  remixclip-companion/  MV3 扩展：小红书 / B站 / 抖音采集
packages/
  contracts/         共享 API 类型
  platform/          spawn / 日志 / HTTP 底层原语
  sidecar/           子进程生命周期（启动 / 发现 / 停止 / 日志）
  sidecar-proto/     sidecar 常量与 IPC 协议
tools/dev/           tools-dev —— 本地生命周期唯一入口
e2e/                 Playwright 视觉回归基线
```

## 快速开始

要求：Node.js 24、pnpm 10.33.x，以及你想用的 agent CLI。

```bash
pnpm install

# 按包构建；仓库刻意没有根级 build 别名，避免各进程以不一致的环境被拉起
pnpm --filter @remixclip/contracts build
pnpm --filter @remixclip/platform build
pnpm --filter @remixclip/sidecar build
pnpm --filter @remixclip/tools-dev build
pnpm --filter @remixclip/daemon build
pnpm --filter @remixclip/web build
pnpm --filter @remixclip/desktop build

# 启动 daemon + web dev server + Electron
pnpm tools-dev
```

桌面窗口会自动打开。开发态 UI 在 <http://127.0.0.1:7457>，daemon 托管的生产 UI 在 <http://127.0.0.1:7456>。

## 开发命令

```bash
pnpm tools-dev                  # 启动 daemon + web + desktop
pnpm tools-dev start daemon     # 只启动 daemon（7456）
pnpm tools-dev start web        # 只启动 web dev server（7457）
pnpm tools-dev start desktop    # 只启动 Electron
pnpm tools-dev status           # 进程状态（基于 argv 发现）
pnpm tools-dev logs daemon      # 跟踪日志（--lines 100）
pnpm tools-dev check            # 快速诊断
pnpm tools-dev stop             # 按进程组停止全部
pnpm tools-dev run web --daemon-port 17456 --web-port 17573   # 前台运行 + 自定义端口
```

daemon / desktop / sidecar / platform 是 tsc 编译型：改完要重新 build 并重启；web 走 dev server 时热更新。

## 校验

```bash
pnpm typecheck        # 全 workspace 类型检查
pnpm i18n:check       # 校验 en / zh-CN 词条对齐
pnpm visual           # Playwright 视觉回归
pnpm visual:record    # 重录基线
```

## 浏览器插件

```bash
pnpm extension:build   # 产出 extensions/remixclip-companion/dist
pnpm extension:dev     # CRXJS 开发态（HMR）
```

在 `chrome://extensions` 打开开发者模式，加载 `dist/`。插件只做两件事：采集当前页内容、通过 `POST /api/library/import` 推送到本地 daemon（默认端点 `http://127.0.0.1:7456`）。

## 数据与日志

| 内容 | 位置 |
| --- | --- |
| SQLite / app-config / 项目工作目录 / 素材媒体 | `apps/.remixclip/`（`remixclip.db`、`app-config.json`、`library.json`、`projects/`、`library-media-cache/`、`artifacts/`） |
| 开发态进程日志 | `~/.local/share/remixclip/<namespace>/<app>/dev/logs/` |

## FAQ

**Electron 报 `does not provide an export named 'BrowserWindow'`？**
终端继承了 `ELECTRON_RUN_AS_NODE=1`（VS Code 系终端会设置）。`pnpm tools-dev` 会自动剔除；手动启动用 `env -u ELECTRON_RUN_AS_NODE pnpm --filter @remixclip/desktop start`。

**daemon 起不来？**
`pnpm tools-dev logs daemon` 看日志，`pnpm tools-dev check` 做诊断。

**端口被占用？**
daemon 默认 7456、web dev 默认 7457；用 `pnpm tools-dev run web --daemon-port 17456 --web-port 17573`，daemon 也接受 `--port` 与 `OD_PORT`。

## 致谢

RemixClip 的架构（daemon 作为唯一数据源的拆分、项目/会话所有权规则、runtime 注册表、SSE run 协议）参考自 [Open Design](https://github.com/Amateur0x1/open-design)，部分代码直接移植。两个项目均以 Apache-2.0 授权，移植部分保持原协议。浏览器插件派生自 `social-media-sniffer`，完整清单见 [NOTICE](NOTICE)。

## License

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
