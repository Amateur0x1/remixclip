// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * YouTube passive sniffing content script — bridge layer.
 *
 * 1. Inject the main-world script that reads `ytInitialPlayerResponse` (player data is a page
 *    global, invisible to an isolated content script).
 * 2. Forward the trimmed post to the service worker.
 * 3. DOM fallback: if the player data was not observable, the watch page's og: tags and the
 *    painted `<video>` still describe the same video. Nothing is invented — an empty page simply
 *    reports nothing and the next tick retries.
 *
 * Capture is opt-in by navigation: only `/watch?v=…` and `/shorts/<id>` ever leave the page.
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

const INJECTED_MESSAGE = "REMIXCLIP_YT_POST";

function currentVideoId(): string | null {
  if (window.location.pathname === "/watch") {
    return new URLSearchParams(window.location.search).get("v");
  }
  return /^\/shorts\/([\w-]+)/.exec(window.location.pathname)?.[1] ?? null;
}

function injectMainWorldScript(): void {
  if (document.querySelector('script[data-remixclip="yt"]')) return;
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/yt-injected.js");
  script.dataset.remixclip = "yt";
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectMainWorldScript();

// Re-inject after YouTube's own SPA navigation replaces the document head.
window.addEventListener("yt-navigate-finish", injectMainWorldScript);

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== INJECTED_MESSAGE) return;
  const videoId = currentVideoId();
  if (!videoId) return;
  const payload = event.data.payload as Record<string, unknown> | undefined;
  if (!payload || String(payload.id ?? "") !== videoId) return;

  const msg: SniffMessage = {
    type: "SNIFFER_DATA",
    platform: "youtube",
    source: "yt_watch",
    payload,
    url: event.data.pageUrl || window.location.href,
    pageUrl: event.data.pageUrl || window.location.href,
    timestamp: Date.now(),
  };

  try {
    chrome.runtime.sendMessage(msg);
  } catch {
    // Extension reloaded/removed while the tab stayed open.
  }
});

// ── DOM fallback ──

function metaContent(property: string): string {
  const element = document.querySelector<HTMLMetaElement>(
    `meta[property="${property}"], meta[name="${property}"]`
  );
  return element?.content?.trim() ?? "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function readAuthor(): string {
  const node = document.querySelector<HTMLElement>(
    "#owner #channel-name a, ytd-channel-name a, #owner ytd-channel-name"
  );
  return node?.textContent?.trim() ?? "";
}

function reportDom(): void {
  const videoId = currentVideoId();
  if (!videoId) return;

  const title = metaContent("og:title").replace(/\s*-\s*YouTube$/, "");
  const image = metaContent("og:image");
  // og:image on a watch page is that video's poster; a generic one (no video id) is not useful.
  if (!title || !isHttpUrl(image) || !image.includes(videoId)) return;

  const payload = {
    id: videoId,
    title,
    description: metaContent("og:description"),
    images: [image],
    videos: [],
    creator: { id: "", username: "", full_name: readAuthor() },
    stats: { likes: 0, comments: 0, saves: 0, shares: 0 },
    tags: [],
  };

  // The DOM exposes the poster and the metadata, not a downloadable stream: the injected script
  // owns video URLs, so this fallback contributes a still frame and nothing else.
  try {
    chrome.runtime.sendMessage({
      type: "SNIFFER_DATA",
      platform: "youtube",
      source: "yt_dom",
      payload,
      url: window.location.href,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    } satisfies SniffMessage);
  } catch {
    // Nothing to report to.
  }
}

let lastDomSignature = "";
window.setInterval(() => {
  const signature = `${currentVideoId()}:${metaContent("og:title")}`;
  if (signature === lastDomSignature) return;
  lastDomSignature = signature;
  reportDom();
}, 2500);

console.log("[RemixClip] YouTube content script 桥接层已就绪 ✓");
