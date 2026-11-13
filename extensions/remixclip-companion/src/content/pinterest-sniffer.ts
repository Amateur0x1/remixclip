// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * Pinterest passive sniffing content script — bridge layer.
 *
 * 1. Inject the main world script that reads Pinterest's own `/resource/` responses.
 * 2. Forward those postMessage payloads to the service worker.
 * 3. DOM fallback for pin pages: `__PWS_DATA__` may be the only visible copy (the resource
 *    response can come from cache), and JSON-LD / og: meta still describe the pin when the
 *    state shape changes. The fallback never invents fields — it only fills what the page shows.
 */

/// <reference types="chrome" />

import type { SniffMessage } from "../types/common";

// ── Inject the main world script ──

function injectMainWorldScript(): void {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("src/content/pinterest-injected.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectMainWorldScript();

// ── Listen to main world postMessage and forward it to the service worker ──

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "PINTEREST_SNIFFER_DATA") return;
  // Capture is opt-in by navigation: home / explore / search / boards must never reach the
  // library, only `/pin/<id>/` pages the user clicked into.
  if (!pinIdFromPath()) return;

  const { source, payload, url, pageUrl } = event.data;

  const msg: SniffMessage = {
    type: "SNIFFER_DATA",
    platform: "pinterest",
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

// ── DOM fallback ──

interface DomPin {
  id: string;
  title: string;
  description: string;
  images: string[];
  video?: { url: string; width?: number; height?: number; duration?: number };
  authorName: string;
  authorUsername: string;
  saves: number;
  comments: number;
  likes: number;
  tags: string[];
}

function pinIdFromPath(): string | null {
  const match = /\/pin\/(\d+)/.exec(window.location.pathname);
  return match?.[1] ?? null;
}

function metaContent(property: string): string {
  const el = document.querySelector<HTMLMetaElement>(
    `meta[property="${property}"], meta[name="${property}"]`,
  );
  return el?.content?.trim() ?? "";
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function jsonLdNodes(): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  );
  for (const script of scripts) {
    if (!script.textContent) continue;
    try {
      const parsed = JSON.parse(script.textContent) as unknown;
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length > 0 && nodes.length < 40) {
        const value = queue.shift();
        if (!value || typeof value !== 'object') continue;
        const record = value as Record<string, unknown>;
        nodes.push(record);
        if (Array.isArray(record['@graph'])) queue.push(...record['@graph']);
      }
    } catch {
      // A malformed block is common on ad-heavy pages; the next one may still be valid.
    }
  }
  return nodes;
}

function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function readJsonLdPin(pinId: string): DomPin | null {
  const nodes = jsonLdNodes();
  // Prefer the post node (`Pin` / `SocialMediaPosting`). Falling back to whatever node carries an
  // image keeps the fallback alive when Pinterest renames the type, without mistaking an unrelated
  // `ImageObject` for the post itself.
  const strict = nodes.filter((node) => {
    const type = String(node['@type'] ?? '');
    const id = String(node['identifier'] ?? node['@id'] ?? '');
    return /^(pin|socialmediaposting)$/i.test(type) || (id !== '' && id.includes(pinId));
  });
  const candidates = strict.length > 0
    ? strict
    : nodes.filter((node) => Boolean(node['image'] || node['contentUrl'] || node['articleBody']));

  for (const node of candidates) {
    const type = String(node['@type'] ?? '');
    const imageValue = node['image'];
    const images: string[] = [];
    const addImage = (value: unknown) => {
      if (isHttpUrl(value) && !images.includes(value)) images.push(value);
      if (Array.isArray(value)) value.forEach(addImage);
      if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        addImage(record['url'] ?? record['contentUrl']);
      }
    };
    addImage(imageValue);

    const author = node['author'] as Record<string, unknown> | string | undefined;
    const authorRecord = author && typeof author === 'object' ? author : null;
    const authorName = authorRecord
      ? String(authorRecord['name'] ?? '')
      : typeof author === 'string' ? author : '';
    const authorUrl = authorRecord ? String(authorRecord['url'] ?? '') : '';
    const username = /pinterest\.[a-z.]+\/([^/?#]+)/i.exec(authorUrl)?.[1] ?? '';

    let saves = 0;
    let comments = numberFrom(node['commentCount']);
    let likes = 0;
    const stats = node['interactionStatistic'];
    if (Array.isArray(stats)) {
      for (const stat of stats) {
        if (!stat || typeof stat !== 'object') continue;
        const record = stat as Record<string, unknown>;
        const kind = String(record['interactionType'] ?? '');
        const count = numberFrom(record['userInteractionCount']);
        if (/save|bookmark|collect/i.test(kind)) saves = count;
        else if (/comment/i.test(kind)) comments = count;
        else if (/like/i.test(kind)) likes = count;
      }
    }

    const videoNode = node['video'] as Record<string, unknown> | undefined;
    const videoUrl = isHttpUrl(videoNode?.['contentUrl'])
      ? String(videoNode?.['contentUrl'])
      : isHttpUrl(node['contentUrl']) && /video/i.test(type) ? String(node['contentUrl']) : undefined;

    return {
      id: pinId,
      title: String(node['headline'] ?? node['name'] ?? '').trim(),
      description: String(node['description'] ?? '').trim(),
      images,
      video: videoUrl ? {
        url: videoUrl,
        width: numberFrom(videoNode?.['width']) || undefined,
        height: numberFrom(videoNode?.['height']) || undefined,
        duration: numberFrom(videoNode?.['duration']) || undefined,
      } : undefined,
      authorName,
      authorUsername: username,
      saves,
      comments,
      likes,
      tags: [],
    };
  }
  return null;
}

/** Merge meta tags and the playing video into a JSON-LD result (or stand alone when absent). */
function readDomPin(): DomPin | null {
  const pinId = pinIdFromPath();
  if (!pinId) return null;

  const base = readJsonLdPin(pinId) ?? {
    id: pinId,
    title: metaContent('og:title'),
    description: metaContent('og:description'),
    images: [],
    authorName: '',
    authorUsername: '',
    saves: 0,
    comments: 0,
    likes: 0,
    tags: [],
  };

  const ogImage = metaContent('og:image');
  if (isHttpUrl(ogImage) && !base.images.includes(ogImage)) base.images.push(ogImage);

  if (!base.title) base.title = metaContent('og:title') || document.title.replace(/\s*\|.*$/, '').trim();
  if (!base.description) base.description = metaContent('og:description');

  if (!base.video) {
    const players = Array.from(document.querySelectorAll<HTMLVideoElement>('video'));
    const player = players.find((candidate) => {
      const src = candidate.currentSrc || candidate.src;
      return isHttpUrl(src);
    });
    if (player) {
      const src = player.currentSrc || player.src;
      base.video = {
        url: src,
        width: player.videoWidth || undefined,
        height: player.videoHeight || undefined,
        duration: Number.isFinite(player.duration) ? Math.round(player.duration) : undefined,
      };
    } else {
      const ogVideo = metaContent('og:video');
      if (isHttpUrl(ogVideo)) base.video = { url: ogVideo };
    }
  }

  // No media at all means the page has not painted the pin yet; a retry will pick it up.
  if (base.images.length === 0 && !base.video) return null;
  return base;
}

let lastSignature = '';

function reportDomPin(): void {
  const pin = readDomPin();
  if (!pin) return;
  const signature = `${pin.id}:${pin.images[0] ?? ''}:${pin.video?.url ?? ''}`;
  if (signature === lastSignature) return;
  lastSignature = signature;

  try {
    chrome.runtime.sendMessage({
      type: 'SNIFFER_DATA',
      platform: 'pinterest',
      source: 'pinterest_dom',
      payload: {
        id: pin.id,
        title: pin.title,
        description: pin.description,
        images: pin.images,
        videos: pin.video ? [pin.video] : [],
        creator: {
          id: pin.authorUsername,
          username: pin.authorUsername,
          full_name: pin.authorName,
        },
        stats: { saves: pin.saves, comments: pin.comments, likes: pin.likes, shares: 0 },
        tags: pin.tags,
      },
      url: window.location.href,
      pageUrl: window.location.href,
      timestamp: Date.now(),
    });
  } catch {
    // The extension was reloaded/removed while this page stayed open: nothing to report to.
  }
}

// Pinterest is a SPA: the player and the pin block mount after the route change, so poll instead
// of guessing when to look. Two querySelector passes per tick are cheap.
window.setInterval(reportDomPin, 2000);
reportDomPin();

console.log('[RemixClip] Pinterest content script 桥接层已就绪 ✓');
