// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json";

export default defineManifest({
  manifest_version: 3,
  name: "RemixClip 素材助手",
  short_name: "RemixClip",
  // Version is maintained only in package.json, so two hand-written copies cannot drift
  version: pkg.version,
  description: "被动采集小红书、B站、抖音的内容，一键推送到 RemixClip 素材库。",
  icons: {
    "16": "public/icon16.png",
    "48": "public/icon48.png",
    "128": "public/icon128.png",
  },
  action: {
    default_title: "打开 RemixClip 素材助手",
    default_icon: {
      "16": "public/icon16.png",
      "48": "public/icon48.png",
      "128": "public/icon128.png",
    },
  },
  side_panel: {
    default_path: "index.html",
  },
  // unlimitedStorage: after chunking, comments + notes exceed storage.local's default 10MB.
  // Only permissions actually used are kept; tabs / activeTab are never called in the code.
  permissions: ["sidePanel", "storage", "unlimitedStorage"],
  // The RemixClip daemon only listens on the local loopback address; the extension pushes
  // exported content to the library.
  host_permissions: ["http://127.0.0.1/*", "http://localhost/*"],
  background: {
    service_worker: "src/service_worker.ts",
  },
  content_scripts: [
    // Xiaohongshu
    {
      js: ["src/content/xhs-sniffer.ts"],
      matches: ["https://www.xiaohongshu.com/*"],
      run_at: "document_start",
    },
    // Bilibili
    {
      js: ["src/content/bili-sniffer.ts"],
      matches: [
        "https://www.bilibili.com/*",
        "https://space.bilibili.com/*",
        "https://search.bilibili.com/*",
      ],
      run_at: "document_start",
    },
    // Douyin
    {
      js: ["src/content/dy-sniffer.ts"],
      matches: ["https://www.douyin.com/*"],
      run_at: "document_start",
    },
  ],
  web_accessible_resources: [
    {
      resources: ["src/content/xhs-injected.js"],
      matches: ["https://www.xiaohongshu.com/*"],
    },
    {
      resources: ["src/content/bili-injected.js"],
      matches: [
        "https://www.bilibili.com/*",
        "https://space.bilibili.com/*",
        "https://search.bilibili.com/*",
      ],
    },
    {
      resources: ["src/content/dy-injected.js"],
      matches: ["https://www.douyin.com/*"],
    },
  ],
});
