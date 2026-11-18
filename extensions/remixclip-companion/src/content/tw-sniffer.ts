// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * X (Twitter) passive capture — DOM only.
 *
 * X renders a post as `<article data-testid="tweet">` and keeps no stable page global, so the
 * detail page is read as it is painted: text, author, media elements and the count buttons.
 * Only `/status/<id>` pages report; the timeline never leaves the page.
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

const MESSAGE_SOURCE = "tw_status";

function statusId(): string | null {
  return /\/status\/(\d+)/.exec(window.location.pathname)?.[1] ?? null;
}

function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function metaContent(property: string): string {
  const element = document.querySelector<HTMLMetaElement>(
    `meta[property="${property}"], meta[name="${property}"]`
  );
  return element?.content?.trim() ?? "";
}

/** "1.2K" / "12,345" / "3 replies, 56 likes" → number. */
function parseCount(raw: string): number {
  const match = /([\d.,]+)\s*([KMB])?/i.exec((raw || "").replace(/\s+/g, ""));
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] || "").toUpperCase();
  const factor = unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return Math.round(value * factor);
}

function statOf(testId: string): number {
  const element = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) return 0;
  return parseCount(element.getAttribute("aria-label") || element.textContent || "");
}

/** `pbs.twimg.com/media/…?name=small` is a thumbnail; `name=orig` is the uploaded file. */
function originalImage(url: string): string {
  if (!isHttpUrl(url)) return "";
  if (/[?&]name=[^&]+/.test(url)) return url.replace(/([?&])name=[^&]+/, "$1name=orig");
  return `${url}${url.includes("?") ? "&" : "?"}name=orig`;
}

function collectImages(): string[] {
  const urls: string[] = [];
  const nodes = document.querySelectorAll<HTMLImageElement>('img[src*="pbs.twimg.com/media"]');
  for (const node of Array.from(nodes)) {
    const url = originalImage(node.currentSrc || node.src);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls.slice(0, 8);
}

interface TwVideo {
  url: string;
  width?: number;
  height?: number;
  duration?: number;
}

function collectVideos(): TwVideo[] {
  const videos: TwVideo[] = [];
  const add = (url: string, width?: number, height?: number, duration?: number) => {
    if (!isHttpUrl(url) || videos.some((video) => video.url === url)) return;
    videos.push({ url, width, height, duration });
  };

  for (const node of Array.from(document.querySelectorAll<HTMLVideoElement>("video"))) {
    const sources = [
      node.currentSrc,
      node.src,
      ...Array.from(node.querySelectorAll("source")).map((source) => source.src),
    ].filter(isHttpUrl);
    const mp4 = sources.find((url) => /\.mp4(\?|$)/i.test(url));
    const hls = sources.find((url) => /\.m3u8(\?|$)/i.test(url));
    const duration = Number.isFinite(node.duration) ? Math.round(node.duration) : undefined;
    add(mp4 || hls || "", node.videoWidth || undefined, node.videoHeight || undefined, duration);
  }

  // X ships the HLS manifest in the card metadata even before the player mounts.
  const meta = metaContent("og:video") || metaContent("twitter:player:stream");
  if (isHttpUrl(meta)) add(meta);
  return videos;
}

function readAuthor(): { username: string; fullName: string } {
  const block = document.querySelector<HTMLElement>('[data-testid="User-Name"]');
  if (!block) return { username: "", fullName: "" };
  const link = block.querySelector<HTMLAnchorElement>('a[href^="/"]:not([href*="/status/"])');
  const username = (link?.getAttribute("href") || "").replace(/^\//, "").split("/")[0] || "";
  const fullName = block.querySelector<HTMLElement>("span")?.textContent?.trim() || "";
  return { username, fullName };
}

let lastSignature = "";

function report(): void {
  const id = statusId();
  if (!id) return;

  const article = document.querySelector<HTMLElement>('article[data-testid="tweet"]');
  if (!article) return;

  const textNode = article.querySelector<HTMLElement>('[data-testid="tweetText"]');
  const text = textNode?.innerText?.trim() || "";
  const images = collectImages();
  const videos = collectVideos();
  if (!text && images.length === 0 && videos.length === 0) return;

  const signature = `${id}:${text.slice(0, 40)}:${images.length}:${videos.length}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  const author = readAuthor();
  const payload = {
    id,
    title: text.split("\n")[0].slice(0, 120),
    description: text,
    images,
    videos,
    creator: { id: author.username, username: author.username, full_name: author.fullName },
    stats: {
      likes: statOf("like"),
      comments: statOf("reply"),
      shares: statOf("retweet"),
      saves: statOf("bookmark"),
    },
    created_at: article.querySelector("time[datetime]")?.getAttribute("datetime") || "",
    tags: [],
  };

  try {
    chrome.runtime.sendMessage({
      type: "SNIFFER_DATA",
      platform: "twitter",
      source: MESSAGE_SOURCE,
      payload,
      url: window.location.href,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    } satisfies SniffMessage);
  } catch {
    // Extension context gone.
  }
}

window.setInterval(report, 2000);

console.log("[RemixClip] X content script 已就绪 ✓");
