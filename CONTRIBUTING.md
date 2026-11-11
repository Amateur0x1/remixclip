# Contributing to RemixClip

Thanks for taking the time to contribute. RemixClip accepts pull requests — bug
fixes, documentation, performance work, and focused features are all welcome.

## Before you start

- **Open an issue first** for anything larger than a small fix. It is much
  cheaper to agree on the approach before you write the code.
- **Keep a pull request focused.** One concern per PR; unrelated refactors,
  formatting sweeps, and dependency bumps belong in their own PR.
- **Match the surrounding code.** Each file starts with an `[INPUT] / [OUTPUT] /
  [POS]` header describing its contract — keep it accurate when you change the
  file's role.
- **Discuss big architectural changes early.** The daemon, web app, desktop
  shell, and browser companion share contracts that are easy to break.

## Development setup

Requirements: **Node 24** (see `.nvmrc`) and **pnpm 10.33.x**.

```bash
git clone https://github.com/Amateur0x1/remixclip.git
cd remixclip
pnpm install
pnpm tools-dev        # runs daemon + web + desktop in watch mode
```

The browser companion under `extensions/remixclip-companion` is a **standalone
pnpm project** with its own lockfile, so it is installed separately:

```bash
pnpm extension:install
pnpm extension:build   # or: pnpm extension:dev
```

> Dependencies are resolved from the public registry pinned in `.npmrc`. If you
> develop behind a mirror, override it per command
> (`pnpm install --registry=<mirror>`) — never commit mirror-specific URLs, they
> end up in the lockfile and break CI.

## Checks

Run the same checks CI runs before you open a pull request:

```bash
pnpm typecheck
pnpm i18n:check
pnpm --filter @remixclip/tools-pack test
pnpm extension:build
```

If your change touches packaging, also smoke-test the bundle:

```bash
pnpm package:dir
pnpm package:verify
```

Windows, macOS, and Linux artifacts are built by CI; you do not need to produce
installers locally.

## Pull requests

1. Fork the repository and branch from `main`.
2. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   subjects, matching scopes already in the history (`feat(web):`, `fix(daemon):`,
   `ci(release):`, …).
3. Describe **what** changed and **why**. Link the issue it closes. UI changes
   should include a screenshot or a short recording.
4. Keep the diff reviewable. If a reviewer asks for a change, push a new commit
   instead of force-pushing — review history is useful.
5. CI must be green. A maintainer merges the PR once it is reviewed.

Every push to `main` builds a full multi-platform snapshot; a tagged release
(`v0.2.0`) publishes a stable build. If your change lands on `main` it will be
packaged, so please make sure the packaging checks above pass.

## Reporting bugs

Open an issue with:

- steps to reproduce,
- operating system and Node version,
- the relevant output of `pnpm tools-dev logs daemon` (if the daemon is involved),
- what you expected instead.

## Security issues

Please **do not** open a public issue. Report privately to the maintainer listed
on the repository profile; you will get an acknowledgement as soon as possible.

## Language

Issues and pull requests are welcome in Chinese or English.

## License

RemixClip is licensed under the [Apache License 2.0](LICENSE). By submitting a
pull request you agree that your contribution is licensed under the same terms.
Attribution and derivation notes live in [NOTICE](NOTICE); the architecture
follows [Open Design](https://github.com/Amateur0x1/open-design) (also
Apache-2.0).
