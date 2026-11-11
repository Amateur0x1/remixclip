// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

/**
 * Douyin passive sniffing content script — bridge layer.
 *
 * 1. Inject the main world script
 * 2. Listen to postMessage (including pageUrl) and forward it to the service worker
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

// ── Inject the main world script ──

function injectMainWorldScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/dy-injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectMainWorldScript();

// ── Listen to main world postMessage and forward it to the service worker ──

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "DY_SNIFFER_DATA") return;

  const { source, payload, url, pageUrl } = event.data;

  const msg: SniffMessage = {
    type: "SNIFFER_DATA",
    platform: "douyin",
    source,
    payload,
    url,
    pageUrl: pageUrl || window.location.href,
    timestamp: Date.now(),
  };

  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    // Silently ignore when the extension context has been destroyed
  }
});

console.log("[RemixClip] 抖音 content script 桥接层已就绪 ✓");
