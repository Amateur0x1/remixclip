/**
 * Cross-platform shared type definitions.
 * Message protocol and enums shared by all platforms.
 */

// ── Platform identifiers ──

export type PlatformKey = "xhs" | "bilibili" | "douyin";

// ── Sniff sources ──

export type SniffSource =
  // Xiaohongshu
  | "feed"
  | "comment"
  | "user_posted"
  // Bilibili
  | "bili_playurl"
  | "bili_rcmd"
  | "bili_popular"
  | "bili_video_detail"
  | "bili_reply"
  | "bili_user_video"
  // Douyin
  | "dy_recommend"
  | "dy_video_detail"
  | "dy_comment"
  | "dy_user_post"
  | "dy_user_profile";

// ── Content Script → Service Worker shared message ──

export interface SniffMessage {
  type: "SNIFFER_DATA";
  platform: PlatformKey;
  source: SniffSource;
  payload: unknown;
  url: string;
  /** URL of the page that issued the request, used to infer the source scenario */
  pageUrl: string;
  timestamp: number;
}
