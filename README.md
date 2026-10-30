# RemixClip

**Language:** English · [简体中文](README.zh-CN.md)

A local-first workspace for agent-assisted content work. RemixClip discovers the agent CLIs installed on your machine (claude / codex / gemini / kimi / qwen / hermes / opencode / pi, and more) and adds project, conversation, and media-library structure on top of those bare runtimes. A companion browser extension pushes content from Xiaohongshu, Bilibili, and Douyin into the local library.

> **Status:** the architecture is still moving, so **code contributions are not accepted yet** — see [CONTRIBUTING.md](CONTRIBUTING.md).
>
> The architecture follows [Open Design](https://github.com/Amateur0x1/open-design) closely, and parts of the implementation are ported from it. Both projects are licensed under Apache-2.0; ported portions remain under the same license. See [NOTICE](NOTICE).

## Pieces

| Piece | Location | Responsibility |
| --- | --- | --- |
| daemon | `apps/daemon` | The only backend and only source of truth: HTTP API, SQLite, agent subprocesses, media processing |
| web | `apps/web` | Next.js UI (static export; dev server for HMR) |
| desktop | `apps/desktop` | Thin Electron shell: the window, plus daemon startup when packaged |
| companion | `extensions/remixclip-companion` | Browser side panel that captures content and imports it into the library |
| contracts | `packages/contracts` | Shared API types — the single protocol source |

## Core model

- **Project** — a container with a name, custom instructions, and a working directory. Deleting a project cascades to its conversations and artifacts, after cancelling anything still running inside it.
- **Conversation** — belongs to exactly one project (`project_id NOT NULL`) and is never moved between projects. A new project comes with a seed conversation.
- **Run** — one agent turn. Created with `POST /api/runs`; events stream over SSE and replay with `?after=<seq>`.
- **Library item** — captured content plus local media, shot analysis, comparisons, and rendered output.
- **App config** — global preferences: selected agent, per-agent model, per-agent CLI env allowlist.

There is no “agent profile” layer: the runtime and model come from app config, and each conversation records its own runtime and working directory.

## Architecture

```
Electron shell ──┐                       ┌── Companion extension (side panel)
                 │ loads UI              │   POST /api/library/import
                 ▼                       ▼
           web UI (Next.js) ── HTTP + SSE ── daemon (Express, 127.0.0.1:7456)
                                               ├── SQLite (projects / conversations / messages)
                                               ├── library/ (items / media / shots / comparisons)
                                               └── runtimes/ → spawns a local agent CLI
```

The daemon is the single source of truth. The web UI, the Electron shell, and the extension are clients; none of them keeps a second copy of the data.

A run, end to end:

1. The UI posts the message (plus optional attachments and UI locale) to `/api/runs`.
2. The daemon resolves the global agent, checks that the conversation belongs to the declared project, and rejects a second concurrent run on the same conversation.
3. It assembles the prompt, writes the conversation / user message / run record in one transaction, then spawns the CLI with the prompt on stdin, in a temp file, or over ACP depending on the runtime.
4. The runtime's output is parsed line by line into typed payloads, tagged with a sequence number, and broadcast to `GET /api/runs/:id/events`.
5. On terminal state the assistant text, artifacts, and the upstream session handle are persisted so the next turn can resume.

Library pipeline:

```
extension import → library_items + batch
  → download (ffmpeg)   → media_files
  → analyze (ffmpeg)    → shots
  → renders (upload)    → comparisons (pixel diff)
```

Shot analysis and comparison only read local files: social-media video URLs are hotlink-protected and expire.

## Package layout

```
apps/
  daemon/            HTTP routes, run lifecycle, runtime spawning, library and media processing
    src/routes/      projects / conversations / runs / library / agents / system
    src/runtimes/    registry, executable resolution, process and event parsing
    src/library/     storage, download queue, ffmpeg shots, renders, comparison
  web/               chat + library UI (components/workspace, components/library, i18n)
  desktop/           Electron shell
  packaged/          packaging entry
extensions/
  remixclip-companion/  MV3 extension: Xiaohongshu / Bilibili / Douyin capture
packages/
  contracts/         shared API types
  platform/          spawn / logging / HTTP primitives
  sidecar/           subprocess lifecycle (launch / discover / stop / logs)
  sidecar-proto/     sidecar constants and IPC protocol
tools/dev/           tools-dev — the single local lifecycle entry point
e2e/                 Playwright visual regression baselines
```

## Quick start

Requirements: Node.js 24, pnpm 10.33.x, and whichever agent CLIs you want to use.

```bash
pnpm install

# Build per package; there is intentionally no root build alias, so every process
# starts with a consistent environment.
pnpm --filter @remixclip/contracts build
pnpm --filter @remixclip/platform build
pnpm --filter @remixclip/sidecar build
pnpm --filter @remixclip/tools-dev build
pnpm --filter @remixclip/daemon build
pnpm --filter @remixclip/web build
pnpm --filter @remixclip/desktop build

# daemon + web dev server + Electron
pnpm tools-dev
```

The desktop window opens automatically. The dev UI is served at <http://127.0.0.1:7457>; the daemon serves the production UI at <http://127.0.0.1:7456>.

## Development commands

```bash
pnpm tools-dev                  # start daemon + web + desktop
pnpm tools-dev start daemon     # daemon only (7456)
pnpm tools-dev start web        # web dev server only (7457)
pnpm tools-dev start desktop    # Electron only
pnpm tools-dev status           # process status (argv-based discovery)
pnpm tools-dev logs daemon      # follow logs (--lines 100)
pnpm tools-dev check            # quick diagnostics
pnpm tools-dev stop             # stop everything by process group
pnpm tools-dev run web --daemon-port 17456 --web-port 17573   # foreground, custom ports
```

`daemon`, `desktop`, `sidecar`, and `platform` are tsc-compiled: rebuild and restart after changes. The web app hot-reloads through the dev server.

## Checks

```bash
pnpm typecheck        # type-check every workspace package
pnpm i18n:check       # verify en / zh-CN key parity
pnpm visual           # Playwright visual regression
pnpm visual:record    # re-record baselines
```

## Browser extension

```bash
pnpm extension:build   # outputs extensions/remixclip-companion/dist
pnpm extension:dev     # CRXJS dev build with HMR
```

Load `dist/` from `chrome://extensions` with developer mode enabled. The extension only captures the current page and pushes it to the local daemon via `POST /api/library/import` (default endpoint `http://127.0.0.1:7456`).

## Data and logs

| Content | Location |
| --- | --- |
| SQLite, app config, project working directories, library media | `apps/.remixclip/` (`remixclip.db`, `app-config.json`, `library.json`, `projects/`, `library-media-cache/`, `artifacts/`) |
| Development process logs | `~/.local/share/remixclip/<namespace>/<app>/dev/logs/` |

## FAQ

**Electron reports `does not provide an export named 'BrowserWindow'`.**
The terminal may have inherited `ELECTRON_RUN_AS_NODE=1` (VS Code terminals do this). `pnpm tools-dev` strips it; for a manual start use `env -u ELECTRON_RUN_AS_NODE pnpm --filter @remixclip/desktop start`.

**The daemon does not start.**
Run `pnpm tools-dev logs daemon` and `pnpm tools-dev check`.

**A port is already in use.**
The daemon defaults to 7456 and the web dev server to 7457. Use `pnpm tools-dev run web --daemon-port 17456 --web-port 17573`; the daemon also accepts `--port` and `OD_PORT`.

## Acknowledgements

RemixClip's architecture — the daemon-as-single-source-of-truth split, the project/conversation ownership rules, the runtime registry, and the SSE run protocol — follows [Open Design](https://github.com/Amateur0x1/open-design). Both projects are Apache-2.0; ported code keeps its original license. The companion extension is derived from `social-media-sniffer`; see [NOTICE](NOTICE) for the full inventory.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
