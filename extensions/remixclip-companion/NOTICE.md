# NOTICE — RemixClip 素材助手 (remixclip-companion)

Copyright 2026 RemixClip

This package is licensed under the Apache License, Version 2.0.
See the `LICENSE` file in this directory, or the repository root `LICENSE`.

## Vendored origin

- Upstream project: social-media-sniffer
- Upstream URL: https://github.com/Amateur0x1/social-media-sniffer
- Copied subdirectory: `extension/`
- Snapshot commit: `0a68863349c76af8c2819b402dca9142732cab7c` (2026-10-29, upstream v0.4.0)

## Modifications since that snapshot

Brand changed from social-media-sniffer to RemixClip 素材助手, and the extension
was wired to the local RemixClip daemon.

Modified files: `index.html`, `manifest.config.ts`, `package.json`,
`src/App.tsx`, `src/content/{xhs,bili,dy}-sniffer.ts`,
`src/content/{xhs,bili,dy}-injected.js`, `src/service_worker.ts`,
`src/store/sniffer-store.ts`.
Added: `src/lib/remixclip.ts` (daemon pairing / ping / import), this package's
own independent `pnpm-lock.yaml`, and this package's own `LICENSE` and
`NOTICE.md` files.

Concretely: `host_permissions` gained `http://127.0.0.1/*` and
`http://localhost/*`; the unused `tabs` and `activeTab` permissions were
removed; message and storage identifiers were renamed.

## Licensing of this copy

The upstream snapshot contains no LICENSE file and its `package.json` carries no
`license` field, so that snapshot is "all rights reserved" by default and this
copy inherits no upstream license. The copyright holder of this copy (the same
party as the upstream author) re-declares it under Apache-2.0 here.

The full attribution record, including third-party assets and the production
dependency inventory, lives in the repository root: [`../NOTICE`](../NOTICE) and
[`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
