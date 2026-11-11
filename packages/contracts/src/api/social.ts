/**
 * [INPUT]: post links and ids coming from the Chrome extension, pasted URLs, or stored library items.
 * [OUTPUT]: per-platform link schemas (hosts + path patterns), canonical link builders, the metric
 *           surface each platform exposes, and parse/build helpers derived from them.
 * [POS]: The one place that knows what a Xiaohongshu / Bilibili / Douyin post *is*. The daemon uses
 *        it to normalize page URLs and recover ids that the payload forgot; the web uses it to render
 *        platform-correct metrics and link labels. Adding a platform means editing this file only.
 */
import { z } from 'zod';
import { SOCIAL_PLATFORMS, type SocialPlatform } from './library.js';

/** The four engagement numbers the library stores; each platform exposes a different subset/order. */
export const SOCIAL_METRIC_KEYS = ['likes', 'collects', 'comments', 'shares'] as const;

export type SocialMetricKey = (typeof SOCIAL_METRIC_KEYS)[number];

export interface SocialPlatformDefinition {
  /** Hosts that belong to the platform; subdomains (www., space., m.) are accepted. */
  readonly hosts: readonly string[];
  /** Path patterns whose first capture group is the post id. */
  readonly postPatterns: readonly RegExp[];
  /** Metrics this platform actually surfaces, in the order the detail view should show them. */
  readonly metrics: readonly SocialMetricKey[];
  /** Canonical post URL, or null when the id cannot produce one. */
  buildLink(remoteId: string): string | null;
}

/**
 * Platform registry. The patterns are deliberately anchored at the path root: a feed page or a
 * profile page is not a post, and turning it into one would create library items that can never be
 * opened.
 */
export const SOCIAL_PLATFORM_SCHEMAS: Record<SocialPlatform, SocialPlatformDefinition> = {
  xhs: {
    hosts: ['xiaohongshu.com'],
    postPatterns: [/^\/(?:explore|discovery\/item)\/([0-9A-Za-z]+)/],
    // 小红书 shows 点赞 / 收藏 / 评论 / 分享 in that order.
    metrics: ['likes', 'collects', 'comments', 'shares'],
    buildLink: (remoteId) => `https://www.xiaohongshu.com/explore/${encodeURIComponent(remoteId)}`,
  },
  bilibili: {
    hosts: ['bilibili.com'],
    // BV ids are canonical; legacy av ids still appear in old exports.
    postPatterns: [/^\/video\/(BV[0-9A-Za-z]+)/, /^\/video\/(av\d+)/i],
    metrics: ['likes', 'collects', 'comments', 'shares'],
    buildLink: (remoteId) => {
      if (/^BV[0-9A-Za-z]+$/.test(remoteId)) return `https://www.bilibili.com/video/${remoteId}`;
      if (/^av\d+$/i.test(remoteId)) return `https://www.bilibili.com/video/${remoteId.toLowerCase()}`;
      // Old exports carry the numeric aid without the `av` prefix.
      if (/^\d+$/.test(remoteId)) return `https://www.bilibili.com/video/av${remoteId}`;
      return null;
    },
  },
  douyin: {
    hosts: ['douyin.com', 'iesdouyin.com'],
    // `/share/video/<id>` is what the share sheet produces; `/note/<id>` is an image post.
    postPatterns: [/^\/(?:video|note)\/(\d+)/, /^\/share\/(?:video|note)\/(\d+)/],
    // 抖音 shows 点赞 / 评论 / 收藏 / 分享 (comments rank above saves).
    metrics: ['likes', 'comments', 'collects', 'shares'],
    buildLink: (remoteId) => `https://www.douyin.com/video/${encodeURIComponent(remoteId)}`,
  },
};

export interface SocialLink {
  platform: SocialPlatform;
  /** Platform-native post id (note id / BV id / aweme id). */
  remoteId: string;
  /** Canonical, shareable post URL built from the id (not the redirect/short link that came in). */
  canonicalUrl: string;
}

/**
 * Recognize a post link. Returns null for anything that is not a post URL of a supported platform —
 * profile pages, feed pages, short links that need a redirect (e.g. b23.tv/xxx) and unrelated sites.
 */
export function parseSocialLink(raw: string | null | undefined): SocialLink | null {
  if (!raw) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const platform of SOCIAL_PLATFORMS) {
    const definition = SOCIAL_PLATFORM_SCHEMAS[platform];
    const onHost = definition.hosts.some((item) => host === item || host.endsWith(`.${item}`));
    if (!onHost) continue;
    for (const pattern of definition.postPatterns) {
      const match = url.pathname.match(pattern);
      const remoteId = match?.[1];
      if (!remoteId) continue;
      const canonicalUrl = definition.buildLink(remoteId) ?? url.toString();
      return { platform, remoteId, canonicalUrl };
    }
  }
  return null;
}

/** Canonical post URL for a stored id; null when the platform has no link shape for it. */
export function buildSocialLink(platform: SocialPlatform, remoteId: string): string | null {
  return SOCIAL_PLATFORM_SCHEMAS[platform].buildLink(remoteId) ?? null;
}

/** Metrics a platform surfaces, in display order. */
export function socialMetricKeys(platform: SocialPlatform): readonly SocialMetricKey[] {
  return SOCIAL_PLATFORM_SCHEMAS[platform].metrics;
}

/** Request-body schema for "here is a post link": rejects links no platform can render. */
export const socialLinkSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => parseSocialLink(value) != null, { message: '不支持的社媒链接' });
