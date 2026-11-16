// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * Instagram passive capture — DOM only.
 *
 * Instagram has no stable page global and blocks most JSON endpoints, so a post/reel detail page
 * is read from what it renders: the header link (author), og: tags (caption), the media elements
 * and the like/comment counters.
 * Only `/p/<code>/`, `/reel/<code>/` and `/tv/<code>/` report; feed and profiles never do.
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

const MESSAGE_SOURCE = "ig_post";

function postCode(): string | null {
  return /\/(?:p|reel|tv)\/([\w-]+)/.exec(window.location.pathname)?.[1] ?? null;
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

function parseCount(raw: string): number {
  const match = /([\d.,]+)\s*([KMB])?/i.exec((raw || "").replace(/\s+/g, ""));
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] || "").toUpperCase();
  const factor = unit === "K" ? 1e3 : unit === "M" ? 1e6 : unit === "B" ? 1e9 : 1;
  return Math.round(value * factor);
}

function readAuthor(): string {
  const header = document.querySelector<HTMLElement>("article header, header");
  if (!header) return "";
  for (const link of Array.from(header.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))) {
    const handle = (link.getAttribute("href") || "").replace(/^\/|\/$/g, "");
    if (handle && /^[A-Za-z0-9._]+$/.test(handle)) return handle;
  }
  return "";
}

function collectImages(): string[] {
  const urls: string[] = [];
  for (const node of Array.from(document.querySelectorAll<HTMLImageElement>("article img"))) {
    const src = node.currentSrc || node.src;
    if (!isHttpUrl(src)) continue;
    if (!/cdninstagram|fbcdn/i.test(src)) continue;
    if (/profile picture/i.test(node.alt || "")) continue;
    if (!urls.includes(src)) urls.push(src);
  }
  const og = metaContent("og:image");
  if (urls.length === 0 && isHttpUrl(og)) urls.push(og);
  return urls.slice(0, 10);
}

interface IgVideo {
  url: string;
  width?: number;
  height?: number;
  duration?: number;
}

function collectVideos(): IgVideo[] {
  const videos: IgVideo[] = [];
  const add = (url: string, width?: number, height?: number, duration?: number) => {
    if (!isHttpUrl(url) || videos.some((video) => video.url === url)) return;
    videos.push({ url, width, height, duration });
  };

  for (const node of Array.from(document.querySelectorAll<HTMLVideoElement>("article video, video"))) {
    const sources = [
      node.currentSrc,
      node.src,
      ...Array.from(node.querySelectorAll("source")).map((source) => source.src),
    ].filter(isHttpUrl);
    const mp4 = sources.find((url) => /\.mp4(\?|$)/i.test(url));
    const duration = Number.isFinite(node.duration) ? Math.round(node.duration) : undefined;
    add(mp4 || sources[0] || "", node.videoWidth || undefined, node.videoHeight || undefined, duration);
  }

  const og = metaContent("og:video");
  if (isHttpUrl(og)) add(og);
  return videos;
}

/** "1,234 likes, 56 comments - someone on Instagram: “caption”" → caption + counts. */
function readStats(description: string): { likes: number; comments: number; caption: string } {
  const likes = /([\d.,]+)\s+likes?/i.exec(description)?.[1] ?? "";
  const comments = /([\d.,]+)\s+comments?/i.exec(description)?.[1] ?? "";
  const quoted = /Instagram[^:]*:\s*[“"]([\s\S]*?)[”"]\s*$/.exec(metaContent("og:title"));
  // The caption is the only free text; strip the ", N likes, M comments - user on Instagram:"
  // envelope no matter which of the two og tags carried it.
  const cleaned = description
    .replace(/^[\d.,]+\s+likes?,\s*[\d.,]+\s+comments?\s*[-–—]\s*/i, "")
    .replace(/^[\d.,]+\s+likes?\s*[-–—]\s*/i, "")
    .replace(/^.*?\bon Instagram:\s*/i, "")
    .replace(/^[“"]+/, "")
    .replace(/[”"]+$/, "")
    .trim();
  return {
    likes: parseCount(likes),
    comments: parseCount(comments),
    caption: quoted?.[1]?.trim() || cleaned || description,
  };
}

let lastSignature = "";

function report(): void {
  const code = postCode();
  if (!code) return;

  const images = collectImages();
  const videos = collectVideos();
  const description = metaContent("og:description");
  if (images.length === 0 && videos.length === 0) return;

  const signature = `${code}:${images.length}:${videos.length}:${description.slice(0, 40)}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  const stats = readStats(description);
  const author = readAuthor();

  const payload = {
    id: code,
    title: stats.caption.split("\n")[0].slice(0, 120) || `${author} 的 Instagram`,
    description: stats.caption,
    images,
    videos,
    creator: { id: author, username: author, full_name: author },
    stats: { likes: stats.likes, comments: stats.comments, saves: 0, shares: 0 },
    created_at:
      document.querySelector("time[datetime]")?.getAttribute("datetime") || "",
    tags: [],
  };

  try {
    chrome.runtime.sendMessage({
      type: "SNIFFER_DATA",
      platform: "instagram",
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

window.setInterval(report, 2500);

console.log("[RemixClip] Instagram content script 已就绪 ✓");
