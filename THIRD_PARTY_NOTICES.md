# Third-Party Notices — Production Dependencies

**Generated:** 2026-10-29
**Scope:** production dependencies only. devDependencies, build artifacts and vendored `node_modules` copies are intentionally excluded.
**Environment:** macOS arm64, pnpm 10.33.2 (so platform-optional binary packages resolved for this platform only).

## How this file was generated

Commands were run from the repository root, plus once inside the standalone extension package:

```bash
# 1) the pnpm workspace at the repository root (apps/*, packages/*, tools/*, e2e)
pnpm licenses list --prod --json > /tmp/rc-lic-root.json

# 2) the extension, which is NOT part of the workspace and has its own
#    pnpm-lock.yaml + node_modules. --ignore-workspace is required, otherwise
#    pnpm walks up and reports the root workspace instead.
cd extensions/remixclip-companion
pnpm licenses list --prod --json --ignore-workspace > /tmp/rc-lic-ext.json
```

The two JSON reports were merged, de-duplicated by `name@version`, and rendered
as the table below. The **Copyright summary** column is extracted verbatim from
the first `Copyright …` line of each package's shipped LICENSE/COPYING file,
falling back to the `author` field of the package metadata when no such line
exists; it is left empty for licenses that do not require an attribution line
(LGPL, ISC, 0BSD, OFL, CC-BY, and the FFmpeg license URL).

## Reproduce

```bash
pnpm licenses list --prod --json > /tmp/rc-lic-root.json
(cd extensions/remixclip-companion && pnpm licenses list --prod --json --ignore-workspace > /tmp/rc-lic-ext.json)
```

Note: `pnpm licenses list` is available in pnpm 10.x. On older pnpm versions use
`pnpm licenses ls --prod --json`. If the command is unavailable, this file
degrades to a hand-maintained inventory — in that case the header above would be
labelled "手工整理，非生成" instead of the command above.

### Known deviation from the raw command output

The raw `--prod` output contained 319 packages. Three of them — `@playwright/test`,
`playwright` and `playwright-core` — are devDependencies of `e2e/package.json`
(which declares no `dependencies` at all) and were dropped by hand so this file
only carries production dependencies. pnpm 10.33.2 reports them under `--prod`
anyway; other devDependencies (`typescript`, `vite`, `tsx`, `electron`,
`@types/node`, and the e2e-only `pixelmatch@8.0.0`) are correctly filtered out.
`pixelmatch@7.2.0` and `pngjs@7.0.0` stay in the table because they are real
production dependencies of `apps/daemon`.

## Summary

316 production packages in total.

| License | Packages |
| --- | --- |
| MIT | 285 |
| Apache-2.0 | 7 |
| ISC | 11 |
| LGPL-2.1 | 3 |
| BSD-3-Clause | 3 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| MIT OR WTFPL | 1 |
| LGPL-3.0-or-later | 1 |
| 0BSD | 1 |
| CC-BY-4.0 | 1 |
| SIL Open Font License | 1 |
| FFmpeg license URL (see package) | 1 |

Copyleft / attribution notes worth flagging before redistribution:

- `@ffmpeg-installer/*` and `@ffprobe-installer/*` ship LGPL-2.1 binaries, and
  `@img/sharp-libvips-*` ships LGPL-3.0-or-later. Redistributing packaged builds
  must satisfy those terms (see `NOTICE`, "Other Third-Party Assets").
- `caniuse-lite` is CC-BY-4.0 and requires attribution.
- `geist` bundles the Geist fonts under the SIL Open Font License 1.1.

## Packages

| Package | Version | License | Copyright summary |
| --- | --- | --- | --- |
| @ffmpeg-installer/darwin-arm64 | 4.1.5 | https://git.ffmpeg.org/gitweb/ffmpeg.git/blob_plain/HEAD:/LICENSE.md |  |
| @ffmpeg-installer/ffmpeg | 1.1.0 | LGPL-2.1 |  |
| @ffprobe-installer/darwin-arm64 | 5.0.1 | LGPL-2.1 |  |
| @ffprobe-installer/ffprobe | 2.1.2 | LGPL-2.1 |  |
| @floating-ui/core | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/dom | 1.8.0 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/react-dom | 2.1.9 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @floating-ui/utils | 0.2.12 | MIT | Copyright (c) 2021-present Floating UI contributors |
| @img/colour | 1.1.0 | MIT | Copyright (c) 2012 Heather Arthur |
| @img/sharp-darwin-arm64 | 0.34.5 | Apache-2.0 | Lovell Fuller |
| @img/sharp-libvips-darwin-arm64 | 1.2.4 | LGPL-3.0-or-later |  |
| @next/env | 16.2.6 | MIT | Next.js Team |
| @next/swc-darwin-arm64 | 16.2.6 | MIT |  |
| @radix-ui/number | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/primitive | 1.1.7 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-accessible-icon | 1.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-accordion | 1.2.21 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-alert-dialog | 1.1.24 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-arrow | 1.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-aspect-ratio | 1.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-avatar | 1.2.7 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-checkbox | 1.3.12 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-collapsible | 1.1.21 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-collection | 1.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-compose-refs | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-context | 1.2.2 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-context-menu | 2.3.8 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dialog | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-direction | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dismissable-layer | 1.1.20 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-dropdown-menu | 2.1.25 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-focus-guards | 1.1.6 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-focus-scope | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-form | 0.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-hover-card | 1.1.24 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-id | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-label | 2.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-menu | 2.1.25 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-menubar | 1.1.25 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-navigation-menu | 1.3.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-one-time-password-field | 0.1.17 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-password-toggle-field | 0.1.12 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-popover | 1.2.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-popper | 1.3.8 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-portal | 1.1.18 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-presence | 1.1.11 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-primitive | 2.1.11 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-progress | 1.1.17 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-radio-group | 1.4.8 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-roving-focus | 1.1.20 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-scroll-area | 1.3.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-select | 2.3.8 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-separator | 1.1.16 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-slider | 1.5.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-slot | 1.4.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-switch | 1.3.8 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-tabs | 1.1.22 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-toast | 1.2.24 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-toggle | 1.1.19 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-toggle-group | 1.1.20 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-toolbar | 1.1.20 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-tooltip | 1.3.0 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-callback-ref | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-controllable-state | 1.2.6 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-effect-event | 0.0.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-escape-keydown | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-is-hydrated | 0.1.3 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-layout-effect | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-previous | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-rect | 1.1.4 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-use-size | 1.1.5 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/react-visually-hidden | 1.2.12 | MIT | Copyright (c) 2022 WorkOS |
| @radix-ui/rect | 1.1.3 | MIT | Copyright (c) 2022 WorkOS |
| @swc/helpers | 0.5.15 | Apache-2.0 | Copyright 2024 SWC contributors. |
| @types/debug | 4.1.13 | MIT | Copyright (c) Microsoft Corporation. |
| @types/estree | 1.0.9 | MIT | Copyright (c) Microsoft Corporation. |
| @types/estree-jsx | 1.0.5 | MIT | Copyright (c) Microsoft Corporation. |
| @types/hast | 3.0.5 | MIT | Copyright (c) Microsoft Corporation. |
| @types/mdast | 4.0.4 | MIT | Copyright (c) Microsoft Corporation. |
| @types/ms | 2.1.0 | MIT | Copyright (c) Microsoft Corporation. |
| @types/prop-types | 15.7.15 | MIT | Copyright (c) Microsoft Corporation. |
| @types/react | 18.3.29 | MIT | Copyright (c) Microsoft Corporation. |
| @types/react-dom | 18.3.6 | MIT | Copyright (c) Microsoft Corporation. |
| @types/unist | 2.0.11 | MIT | Copyright (c) Microsoft Corporation. |
| @types/unist | 3.0.3 | MIT | Copyright (c) Microsoft Corporation. |
| @ungap/structured-clone | 1.4.0 | ISC |  |
| accepts | 2.0.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| aria-hidden | 1.2.6 | MIT | Copyright (c) 2017 Anton Korzunov |
| bail | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| base64-js | 1.5.1 | MIT | Copyright (c) 2014 Jameson Little |
| baseline-browser-mapping | 2.11.23 | Apache-2.0 |  |
| better-sqlite3 | 12.10.0 | MIT | Copyright (c) 2017 Joshua Wise |
| bindings | 1.5.0 | MIT | Copyright (c) 2012 Nathan Rajlich &lt;nathan@tootallnate.net&gt; |
| bl | 4.1.0 | MIT | Copyright (c) 2013-2019 bl contributors |
| body-parser | 2.3.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| buffer | 5.7.1 | MIT | Copyright (c) Feross Aboukhadijeh, and other contributors. |
| bytes | 3.1.2 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca> |
| cac | 6.7.14 | MIT | Copyright (c) EGOIST <0x142857@gmail.com> (https://github.com/egoist) |
| call-bind-apply-helpers | 1.0.2 | MIT | Copyright (c) 2024 Jordan Harband |
| call-bound | 1.0.4 | MIT | Copyright (c) 2024 Jordan Harband |
| caniuse-lite | 1.0.30001810 | CC-BY-4.0 |  |
| ccount | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities | 2.0.2 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities-html4 | 2.1.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-entities-legacy | 3.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| character-reference-invalid | 2.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| chownr | 1.1.4 | ISC |  |
| class-variance-authority | 0.7.1 | Apache-2.0 | Copyright 2022 Joe Bell |
| client-only | 0.0.1 | MIT |  |
| clsx | 2.1.1 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| comma-separated-tokens | 2.0.3 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| content-disposition | 1.1.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| content-type | 1.0.5 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| content-type | 2.1.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson |
| cookie | 0.7.2 | MIT | Copyright (c) 2012-2014 Roman Shtylman <shtylman@gmail.com> |
| cookie-signature | 1.2.2 | MIT | Copyright (c) 2012–2024 LearnBoost <tj@learnboost.com> and other contributors; |
| csstype | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol |
| debug | 4.4.3 | MIT | Copyright (c) 2014-2017 TJ Holowaychuk <tj@vision-media.ca> |
| decode-named-character-reference | 1.3.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| decompress-response | 6.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| deep-extend | 0.6.0 | MIT | Copyright (c) 2013-2018, Viacheslav Lotsmanov |
| depd | 2.0.0 | MIT | Copyright (c) 2014-2018 Douglas Christopher Wilson |
| dequal | 2.0.3 | MIT | Copyright (c) Luke Edwards <luke.edwards05@gmail.com> (lukeed.com) |
| detect-libc | 2.1.2 | Apache-2.0 | Lovell Fuller |
| detect-node-es | 1.1.0 | MIT | Copyright (c) 2017 Ilya Kantor |
| devlop | 1.1.0 | MIT | Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com> |
| dunder-proto | 1.0.1 | MIT | Copyright (c) 2024 ECMAScript Shims |
| ee-first | 1.1.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com |
| encodeurl | 2.0.0 | MIT | Copyright (c) 2016 Douglas Christopher Wilson |
| end-of-stream | 1.4.5 | MIT | Copyright (c) 2014 Mathias Buus |
| es-define-property | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| es-errors | 1.3.0 | MIT | Copyright (c) 2024 Jordan Harband |
| es-object-atoms | 1.1.2 | MIT | Copyright (c) 2024 Jordan Harband |
| escape-html | 1.0.3 | MIT | Copyright (c) 2012-2013 TJ Holowaychuk |
| escape-string-regexp | 5.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| estree-util-is-identifier-name | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| etag | 1.8.1 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| expand-template | 2.0.3 | (MIT OR WTFPL) | Copyright (c) 2018 Lars-Magnus Skog |
| express | 5.2.1 | MIT | Copyright (c) 2009-2014 TJ Holowaychuk <tj@vision-media.ca> |
| extend | 3.0.2 | MIT | Copyright (c) 2014 Stefan Thomas |
| file-uri-to-path | 1.0.0 | MIT | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net> |
| finalhandler | 2.1.1 | MIT | Copyright (c) 2014-2022 Douglas Christopher Wilson <doug@somethingdoug.com> |
| forwarded | 0.2.0 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| fresh | 2.0.0 | MIT | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca> |
| fs-constants | 1.0.0 | MIT | Copyright (c) 2018 Mathias Buus |
| function-bind | 1.1.2 | MIT | Copyright (c) 2013 Raynos. |
| geist | 1.7.2 | SIL OPEN FONT LICENSE |  |
| get-intrinsic | 1.3.0 | MIT | Copyright (c) 2020 Jordan Harband |
| get-nonce | 1.0.1 | MIT | Copyright (c) 2020 Anton Korzunov |
| get-proto | 1.0.1 | MIT | Copyright (c) 2025 Jordan Harband |
| github-from-package | 0.0.0 | MIT | James Halliday |
| gopd | 1.2.0 | MIT | Copyright (c) 2022 Jordan Harband |
| has-symbols | 1.1.0 | MIT | Copyright (c) 2016 Jordan Harband |
| hasown | 2.0.4 | MIT | Copyright (c) Jordan Harband and contributors |
| hast-util-to-jsx-runtime | 2.3.6 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| hast-util-whitespace | 3.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| html-url-attributes | 3.0.1 | MIT | Copyright (c) Titus Wormer |
| http-errors | 2.0.1 | MIT | Copyright (c) 2014 Jonathan Ong me@jongleberry.com |
| iconv-lite | 0.7.3 | MIT | Copyright (c) 2011 Alexander Shtuchkin |
| ieee754 | 1.2.1 | BSD-3-Clause | Copyright 2008 Fair Oaks Labs, Inc. |
| inherits | 2.0.4 | ISC |  |
| ini | 1.3.8 | ISC |  |
| inline-style-parser | 0.2.7 | MIT | Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca> |
| ipaddr.js | 1.9.1 | MIT | Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org> |
| is-alphabetical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-alphanumerical | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-decimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-hexadecimal | 2.0.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| is-plain-obj | 4.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| is-promise | 4.0.0 | MIT | Copyright (c) 2014 Forbes Lindesay |
| js-tokens | 4.0.0 | MIT | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell |
| longest-streak | 3.1.0 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| loose-envify | 1.4.0 | MIT | Copyright (c) 2015 Andres Suarez <zertosh@gmail.com> |
| lucide-react | 1.54.0 | ISC |  |
| markdown-table | 3.0.4 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| math-intrinsics | 1.1.0 | MIT | Copyright (c) 2024 ECMAScript Shims |
| mdast-util-find-and-replace | 3.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-from-markdown | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm | 3.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-autolink-literal | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-footnote | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-strikethrough | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-table | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-gfm-task-list-item | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdx-expression | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdx-jsx | 3.2.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-mdxjs-esm | 2.0.1 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-phrasing | 4.1.0 | MIT | Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-to-hast | 13.2.1 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| mdast-util-to-markdown | 2.2.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mdast-util-to-string | 4.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| media-typer | 1.1.1 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| merge-descriptors | 2.0.0 | MIT | Copyright (c) Jonathan Ong <me@jongleberry.com> |
| micromark | 4.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-core-commonmark | 2.0.4 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm | 3.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-autolink-literal | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-footnote | 2.1.0 | MIT | Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-strikethrough | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-table | 2.1.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-tagfilter | 2.0.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-extension-gfm-task-list-item | 2.1.0 | MIT | Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-destination | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-label | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-space | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-title | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-factory-whitespace | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-character | 2.1.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-chunked | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-classify-character | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-combine-extensions | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-decode-numeric-character-reference | 2.0.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-decode-string | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-edit-map | 1.0.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-encode | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-html-tag-name | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-normalize-identifier | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-resolve-all | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-sanitize-uri | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-subtokenize | 2.1.0 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-symbol | 2.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| micromark-util-types | 2.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| mime-db | 1.54.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| mime-types | 3.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| mimic-response | 3.1.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com) |
| minimist | 1.2.8 | MIT | James Halliday |
| mkdirp-classic | 0.5.3 | MIT | Copyright (c) 2020 James Halliday (mail@substack.net) and Mathias Buus |
| ms | 2.1.3 | MIT | Copyright (c) 2020 Vercel, Inc. |
| nanoid | 3.3.19 | MIT | Copyright 2017 Andrey Sitnik <andrey@sitnik.ru> |
| napi-build-utils | 2.0.0 | MIT | Copyright (c) 2018 inspiredware |
| negotiator | 1.1.0 | MIT | Copyright (c) 2012-2014 Federico Romero |
| next | 16.2.6 | MIT | Copyright (c) 2025 Vercel, Inc. |
| node-abi | 3.96.0 | MIT | Copyright (c) 2016 Lukas Geiger |
| object-inspect | 1.13.4 | MIT | Copyright (c) 2013 James Halliday |
| on-finished | 2.4.1 | MIT | Copyright (c) 2013 Jonathan Ong <me@jongleberry.com> |
| once | 1.4.0 | ISC |  |
| parse-entities | 4.0.2 | MIT | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> |
| parseurl | 1.3.3 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| path-to-regexp | 8.4.2 | MIT | Copyright (c) 2014 Blake Embrey (hello@blakeembrey.com) |
| picocolors | 1.1.1 | ISC |  |
| pixelmatch | 7.2.0 | ISC |  |
| pngjs | 7.0.0 | MIT |  |
| postcss | 8.4.31 | MIT | Copyright 2013 Andrey Sitnik <andrey@sitnik.ru> |
| prebuild-install | 7.1.3 | MIT | Copyright (c) 2015 Mathias Buus |
| property-information | 7.2.0 | MIT | Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com> |
| proxy-addr | 2.0.7 | MIT | Copyright (c) 2014-2016 Douglas Christopher Wilson |
| pump | 3.0.4 | MIT | Copyright (c) 2014 Mathias Buus |
| qs | 6.16.0 | BSD-3-Clause | Copyright (c) 2014, Nathan LaFreniere and other [contributors](https://github.com/ljharb/qs/graphs/contributors) |
| radix-ui | 1.7.0 | MIT | Copyright (c) 2022 WorkOS |
| range-parser | 1.3.0 | MIT | Copyright (c) 2012-2014 TJ Holowaychuk <tj@vision-media.ca> |
| raw-body | 3.0.2 | MIT | Copyright (c) 2013-2014 Jonathan Ong <me@jongleberry.com> |
| rc | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) | Dominic Tarr |
| react | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| react | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-dom | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| react-dom | 19.3.1 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| react-markdown | 10.1.0 | MIT | Copyright (c) Espen Hovlandsdal |
| react-remove-scroll | 2.7.2 | MIT | Copyright (c) 2017 Anton Korzunov |
| react-remove-scroll-bar | 2.3.8 | MIT | Anton Korzunov |
| react-resizable-panels | 4.14.8 | MIT | Copyright (c) 2018 Brian Vaughn |
| react-style-singleton | 2.2.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| readable-stream | 3.6.2 | MIT |  |
| remark-gfm | 4.0.1 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| remark-parse | 11.0.0 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| remark-rehype | 11.1.2 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| remark-stringify | 11.0.0 | MIT | Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com> |
| router | 2.2.0 | MIT | Copyright (c) 2013 Roman Shtylman |
| safe-buffer | 5.2.1 | MIT | Copyright (c) Feross Aboukhadijeh |
| safer-buffer | 2.1.2 | MIT | Copyright (c) 2018 Nikita Skovoroda <chalkerx@gmail.com> |
| scheduler | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| scheduler | 0.28.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| semver | 7.8.5 | ISC |  |
| send | 1.2.1 | MIT | Copyright (c) 2012 TJ Holowaychuk |
| serve-static | 2.2.1 | MIT | Copyright (c) 2010 Sencha Inc. |
| setprototypeof | 1.2.0 | ISC |  |
| sharp | 0.34.5 | Apache-2.0 | Lovell Fuller |
| side-channel | 1.1.1 | MIT | Copyright (c) 2019 Jordan Harband |
| side-channel-list | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-map | 1.0.1 | MIT | Copyright (c) 2024 Jordan Harband |
| side-channel-weakmap | 1.0.2 | MIT | Copyright (c) 2019 Jordan Harband |
| simple-concat | 1.0.1 | MIT | Copyright (c) Feross Aboukhadijeh |
| simple-get | 4.0.1 | MIT | Copyright (c) Feross Aboukhadijeh |
| source-map-js | 1.2.1 | BSD-3-Clause | Copyright (c) 2009-2011, Mozilla Foundation and contributors |
| space-separated-tokens | 2.0.2 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| statuses | 2.0.2 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| string_decoder | 1.3.0 | MIT |  |
| stringify-entities | 4.0.4 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| strip-json-comments | 2.0.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| style-to-js | 1.1.21 | MIT | Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org> |
| style-to-object | 1.0.14 | MIT | Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org> |
| styled-jsx | 5.1.6 | MIT | Copyright (c) 2016-present Vercel, Inc. |
| tailwind-merge | 3.7.0 | MIT | Copyright (c) 2021 Dany Castillo |
| tar-fs | 2.1.5 | MIT | Copyright (c) 2014 Mathias Buus |
| tar-stream | 2.2.0 | MIT | Copyright (c) 2014 Mathias Buus |
| toidentifier | 1.0.1 | MIT | Copyright (c) 2016 Douglas Christopher Wilson <doug@somethingdoug.com> |
| trim-lines | 3.0.1 | MIT | Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com> |
| trough | 2.2.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| tslib | 2.8.1 | 0BSD | Copyright (c) Microsoft Corporation. |
| tunnel-agent | 0.6.0 | Apache-2.0 | Mikeal Rogers |
| type-is | 2.1.0 | MIT | Copyright (c) 2014 Jonathan Ong <me@jongleberry.com> |
| unified | 11.0.5 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-is | 6.0.1 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-position | 5.0.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-stringify-position | 4.0.0 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| unist-util-visit | 5.1.0 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| unist-util-visit-parents | 6.0.2 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
| unpipe | 1.0.0 | MIT | Copyright (c) 2015 Douglas Christopher Wilson <doug@somethingdoug.com> |
| use-callback-ref | 1.3.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| use-sidecar | 1.1.3 | MIT | Copyright (c) 2017 Anton Korzunov |
| util-deprecate | 1.0.2 | MIT | Copyright (c) 2014 Nathan Rajlich <nathan@tootallnate.net> |
| vary | 1.1.2 | MIT | Copyright (c) 2014-2017 Douglas Christopher Wilson |
| vfile | 6.0.3 | MIT | Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com> |
| vfile-message | 4.0.3 | MIT | Copyright (c) Titus Wormer <tituswormer@gmail.com> |
| wrappy | 1.0.2 | ISC |  |
| zod | 3.25.76 | MIT | Copyright (c) 2025 Colin McDonnell |
| zwitch | 2.0.4 | MIT | Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com> |
