// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

/**
 * Foreground passive sniffing content script — bridge layer.
 *
 * 1. Inject the main world script
 * 2. Listen to postMessage (including pageUrl) and forward it to the service worker
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

// ── Inject the main world script ──

function injectMainWorldScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/xhs-injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectMainWorldScript();

// ── Listen to main world postMessage and forward it to the service worker ──

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "XHS_SNIFFER_DATA") return;

  const { source, payload, url, pageUrl } = event.data;

  const msg: SniffMessage = {
    type: "SNIFFER_DATA",
    platform: "xhs",
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

// ── Video stream fallback ──
//
// Feed responses do not always carry `video.media`, and without it the daemon has no address to
// download: the note lands in the library as an ordinary picture. The detail page is already
// playing the clip, so read the player and hand the service worker what the API did not say.

function noteIdFromPath(): string | null {
  const match = /\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i.exec(window.location.pathname);
  return match?.[1] ?? null;
}

let lastReported = "";

function reportVideoSrc(): void {
  const noteId = noteIdFromPath();
  if (!noteId) return;

  const players = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
  if (players.length === 0) return;
  // Recommendations and ads can add their own players: the note's own is the biggest one.
  const video = players.reduce((largest, candidate) =>
    candidate.clientWidth * candidate.clientHeight > largest.clientWidth * largest.clientHeight
      ? candidate
      : largest,
  );
  const src = video.currentSrc || video.src || video.querySelector<HTMLSourceElement>("source")?.src || "";
  // blob:/MSE sources are local to the page and cannot be fetched by the daemon.
  if (!/^https?:\/\//i.test(src)) return;

  const signature = `${noteId}:${src}`;
  if (signature === lastReported) return;
  lastReported = signature;

  try {
    chrome.runtime.sendMessage({
      type: "SNIFFER_DATA",
      platform: "xhs",
      source: "xhs_video",
      payload: { note_id: noteId, src, poster: video.poster },
      url: window.location.href,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    });
  } catch {
    // The extension was reloaded/removed while this page stayed open: nothing to report to.
  }
}

// The player mounts after the route change and the src appears after the manifest loads, so poll
// instead of guessing when to look. One querySelector pass per tick is cheap.
window.setInterval(reportVideoSrc, 1500);
reportVideoSrc();

// ── Diagnostics ──
//
// When no fetchable address is found, the only way to tell a blob:-only player from a plain miss
// is to record what the page actually had. One compact key, overwritten in place; it is read by
// the desktop side when the capture comes back empty.

const PROBE_KEY = "sms:xhs:video-probe";
let lastProbe = "";

function reportProbe(): void {
  const noteId = noteIdFromPath();
  if (!noteId) return;
  const players = Array.from(document.querySelectorAll<HTMLVideoElement>("video"));
  const first = players[0];
  const src = first?.currentSrc || first?.src || "";
  const perf = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => /\.(?:mp4|m3u8)(?:\?|$)/i.test(name))
    .slice(-3)
    .map((name) => name.slice(0, 160));
  const probe = {
    noteId,
    at: Date.now(),
    videos: players.length,
    srcKind: src.startsWith("blob:") ? "blob" : src ? "http" : "none",
    src: src.slice(0, 160),
    perf,
  };
  const snapshot = JSON.stringify(probe);
  if (snapshot === lastProbe) return;
  lastProbe = snapshot;
  try {
    void chrome.storage.local.set({ [PROBE_KEY]: probe });
  } catch {
    // Diagnostics must never break capture.
  }
}

window.setInterval(reportProbe, 4000);
reportProbe();

console.log("[RemixClip] content script 桥接层已就绪 ✓");
