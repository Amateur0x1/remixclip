// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

/**
 * Passive sniffing data store — multi-platform edition v2.
 *
 * Design principle: store data only, never send requests.
 * All data comes from API responses the page sends itself, captured by the content script
 * and stored here.
 *
 * ## Why sharding
 *
 * v1 stuffed a whole platform's data into a single storage key, so every incoming response
 * had to read all notes + comments and write them back as one block. Past a thousand
 * notes:
 *   1. each write is an O(n) serialization, and one feed refresh can stall the service
 *      worker;
 *   2. chrome.storage.local is 10MB by default, and exceeding the quota throws
 *      QUOTA_BYTES; the old error handling only did console.error, so everything looked
 *      fine to the user while all data was lost.
 *
 * v2 splits into keys sharded by note_id, so a write only touches the slices that really
 * changed:
 *
 *   sms:<platform>:meta               { stats, userProfiles }
 *   sms:<platform>:cards              NoteCard[]
 *   sms:<platform>:note:<note_id>     NoteEntry
 *   sms:<platform>:comment:<note_id>  CommentEntry[]
 *
 * Legacy single-key data is migrated automatically on first read (the old key is removed
 * only after a successful migration).
 */

import type { PlatformKey } from "../types/common";

// ── Page source types ──

/** Page context, distinguishing which scenario the data came from */
export type PageContext =
  | { page: "explore" }
  | { page: "user"; user_id: string; user_name?: string }
  | { page: "note_detail" }; // note/video detail page

// ── Type definitions ──

export interface VideoDetail {
  page_url?: string;
  audio_url?: string;
  referer?: string;
  /** Video stream URL (prefers the highest quality) */
  video_url?: string;
  /** All available video stream URLs */
  video_urls?: string[];
  /** Video duration (seconds) */
  duration?: number;
  /** Original video key */
  origin_video_key?: string;
  /** First frame / thumbnail file_id of the video */
  first_frame_fileid?: string;
  thumbnail_fileid?: string;
  /** Video width and height */
  width?: number;
  height?: number;
}

export interface NoteEntry {
  note_id: string;
  title: string;
  desc: string;
  type: string; // "video" | "normal" | "image"
  time: number;
  ip_location: string;
  like_count: number;
  collect_count: number;
  comment_count: number;
  share_count: number;
  tags: string[];
  images: string[];
  /** Video details of a video note */
  video?: VideoDetail;
  author?: string;
  author_id?: string;
  /** Source page of the data */
  source: "explore" | "user" | "note_detail";
  /** When the source is user, the user_id of the creator it belongs to */
  source_user_id?: string;
  /** Owning platform (stored redundantly to simplify export) */
  platform?: PlatformKey;
  /** Bilibili only: the comment API uses aid as oid, needed to map comments back to bvid */
  aid?: number;
}

export interface CommentEntry {
  cid: string;
  text: string;
  like_count: number;
  sub_comment_count: number;
  create_time: number;
  user_name: string;
  ip_label: string;
}

export interface NoteCard {
  note_id: string;
  xsec_token: string;
  title: string;
  type: string;
  liked_count: number;
  cover_url: string;
  author?: string;
  author_id?: string;
  /** Which creator's profile it was captured from */
  source_user_id?: string;
}

/** Creator info (recorded automatically from user pages) */
export interface UserProfile {
  user_id: string;
  user_name: string;
  /** Note count */
  note_count: number;
  /** First capture time */
  first_seen: number;
  /** Last update */
  updated_at?: number;
  /** The following fields are provided by only some platforms */
  avatar?: string;
  signature?: string;
  follower_count?: number;
  following_count?: number;
  /** Total likes (Douyin) / total plays (extensible for Bilibili) */
  total_favorited?: number;
  platform?: PlatformKey;
}

export interface SnifferStats {
  feedRequests: number;
  commentRequests: number;
  userPostedRequests: number;
}

export interface SnifferData {
  /** Note details stored by note ID */
  notes: Record<string, NoteEntry>;
  /** Comment lists stored by note ID */
  comments: Record<string, CommentEntry[]>;
  /** Creator note card list (from the user_posted API) */
  noteCards: NoteCard[];
  /** Captured creator info */
  userProfiles: Record<string, UserProfile>;
  stats: SnifferStats;
}

/** Incremental change from one sniff pass; only slices present here get written to disk */
export interface SnifferChange {
  meta?: { stats: SnifferStats; userProfiles: Record<string, UserProfile> };
  noteCards?: NoteCard[];
  notes?: NoteEntry[];
  comments?: Array<{ noteId: string; entries: CommentEntry[] }>;
  /** Comment slices to delete (e.g. cleanup after merging aid_ pseudo keys) */
  removedComments?: string[];
}

// ── Initial state ──

function emptyStats(): SnifferStats {
  return {
    feedRequests: 0,
    commentRequests: 0,
    userPostedRequests: 0,
  };
}

function emptyData(): SnifferData {
  return {
    notes: {},
    comments: {},
    noteCards: [],
    userProfiles: {},
    stats: emptyStats(),
  };
}

// ── Storage key layout ──

const NAMESPACE = "sms";

const PREFIXES: Record<PlatformKey, string> = {
  xhs: `${NAMESPACE}:xhs:`,
  bilibili: `${NAMESPACE}:bilibili:`,
  douyin: `${NAMESPACE}:douyin:`,
};

/** v1's single key, used only for migration */
const LEGACY_KEYS: Record<PlatformKey, string> = {
  xhs: "cheat_sniffer_data",
  bilibili: "cheat_sniffer_data_bili",
  douyin: "cheat_sniffer_data_dy",
};

const NOTE_PREFIX = "note:";
const COMMENT_PREFIX = "comment:";
const META_KEY = "meta";
const CARDS_KEY = "cards";

function metaKey(platform: PlatformKey): string {
  return PREFIXES[platform] + META_KEY;
}

function cardsKey(platform: PlatformKey): string {
  return PREFIXES[platform] + CARDS_KEY;
}

function noteKey(platform: PlatformKey, noteId: string): string {
  return PREFIXES[platform] + NOTE_PREFIX + noteId;
}

function commentKey(platform: PlatformKey, noteId: string): string {
  return PREFIXES[platform] + COMMENT_PREFIX + noteId;
}

// ── v1 → v2 migration ──
//
// Migration is deduped via a cached Promise: it never runs twice in the same JS context.
// Across contexts (service worker / side panel) it may run once each, but the writes are
// identical and both follow "write v2 first, then delete the old key", so the worst case
// is writing the same data twice.

const migrationTasks = new Map<PlatformKey, Promise<void>>();

function ensureMigrated(platform: PlatformKey): Promise<void> {
  const existing = migrationTasks.get(platform);
  if (existing) return existing;

  const task = migrateLegacy(platform).catch((err) => {
    console.error("[RemixClip] 数据迁移失败:", err);
  });
  migrationTasks.set(platform, task);
  return task;
}

async function migrateLegacy(platform: PlatformKey): Promise<void> {
  const legacyKey = LEGACY_KEYS[platform];
  const result = await chrome.storage.local.get(legacyKey);
  const legacy = result[legacyKey] as SnifferData | undefined;
  if (!legacy) return;

  await writeSnapshot(platform, legacy);
  await chrome.storage.local.remove(legacyKey);
  console.log("[RemixClip] 已迁移 v1 数据到分片存储:", platform);
}

async function writeSnapshot(platform: PlatformKey, data: SnifferData): Promise<void> {
  const batch: Record<string, unknown> = {
    [metaKey(platform)]: {
      stats: { ...emptyStats(), ...(data.stats ?? {}) },
      userProfiles: data.userProfiles ?? {},
    },
    [cardsKey(platform)]: data.noteCards ?? [],
  };

  for (const [noteId, note] of Object.entries(data.notes ?? {})) {
    batch[noteKey(platform, noteId)] = note;
  }
  for (const [noteId, comments] of Object.entries(data.comments ?? {})) {
    batch[commentKey(platform, noteId)] = comments;
  }

  await chrome.storage.local.set(batch);
}

// ── Read ──

/**
 * Read the full data of a platform (sidebar rendering and post-migration re-reads both
 * go through here).
 *
 * Under the hood it is a single `get(null)`: sharding increases the number of keys, but
 * each slice is small, so the overall transfer is actually smaller than v1's single giant
 * key and never hits the quota.
 */
export async function loadData(platform: PlatformKey = "xhs"): Promise<SnifferData> {
  await ensureMigrated(platform);

  const prefix = PREFIXES[platform];
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const data = emptyData();

  for (const key of Object.keys(all)) {
    if (!key.startsWith(prefix)) continue;

    const rest = key.slice(prefix.length);
    const value = all[key];

    if (rest === META_KEY) {
      const meta = value as { stats?: Partial<SnifferStats>; userProfiles?: Record<string, UserProfile> } | undefined;
      if (meta?.stats) data.stats = { ...emptyStats(), ...meta.stats };
      if (meta?.userProfiles) data.userProfiles = meta.userProfiles;
    } else if (rest === CARDS_KEY) {
      if (Array.isArray(value)) data.noteCards = value as NoteCard[];
    } else if (rest.startsWith(NOTE_PREFIX)) {
      const noteId = rest.slice(NOTE_PREFIX.length);
      if (value) data.notes[noteId] = value as NoteEntry;
    } else if (rest.startsWith(COMMENT_PREFIX)) {
      const noteId = rest.slice(COMMENT_PREFIX.length);
      if (Array.isArray(value)) data.comments[noteId] = value as CommentEntry[];
    }
  }

  return data;
}

// ── Write ──

/** Write only the slices that actually changed this time */
export async function saveChanges(platform: PlatformKey, change: SnifferChange): Promise<void> {
  const batch: Record<string, unknown> = {};

  if (change.meta) batch[metaKey(platform)] = change.meta;
  if (change.noteCards) batch[cardsKey(platform)] = change.noteCards;
  if (change.notes) {
    for (const note of change.notes) batch[noteKey(platform, note.note_id)] = note;
  }
  if (change.comments) {
    for (const { noteId, entries } of change.comments) {
      batch[commentKey(platform, noteId)] = entries;
    }
  }

  if (Object.keys(batch).length === 0) return;
  await chrome.storage.local.set(batch);

  if (change.removedComments?.length) {
    await chrome.storage.local.remove(change.removedComments.map((id) => commentKey(platform, id)));
  }
}

/** Clear all data of a platform (including the legacy key) */
export async function clearData(platform: PlatformKey = "xhs"): Promise<void> {
  const prefix = PREFIXES[platform];
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const keys = Object.keys(all).filter(
    (key) => key.startsWith(prefix) || key === LEGACY_KEYS[platform]
  );
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

// ── Helpers: safe number conversion ──

export function toInt(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return parseInt(v, 10) || 0;
  return 0;
}

// ── Page URL → PageContext parsing ──

/** Xiaohongshu URL parsing */
export function parseXhsPageContext(url: string): PageContext {
  try {
    const u = new URL(url);
    const userMatch = u.pathname.match(/^\/user\/profile\/([a-f0-9]+)/);
    if (userMatch) {
      return { page: "user", user_id: userMatch[1] };
    }
    // Detail pages come in two common forms: /explore/{id} and /discovery/item/{id}
    const noteMatch = u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]+)/);
    if (noteMatch) {
      return { page: "note_detail" };
    }
    return { page: "explore" };
  } catch {
    return { page: "explore" };
  }
}

/** Bilibili URL parsing */
export function parseBiliPageContext(url: string): PageContext {
  try {
    const u = new URL(url);

    // A personal space has two domain forms, and both must be recognized:
    //   https://space.bilibili.com/{mid}/video
    //   https://www.bilibili.com/space/{mid}
    if (u.hostname === "space.bilibili.com") {
      const subMatch = u.pathname.match(/^\/(\d+)/);
      if (subMatch) {
        return { page: "user", user_id: subMatch[1] };
      }
    }

    const spaceMatch = u.pathname.match(/^\/space\/(\d+)/);
    if (spaceMatch) {
      return { page: "user", user_id: spaceMatch[1] };
    }

    // /video/{bvid} video detail
    const videoMatch = u.pathname.match(/^\/video\/(BV[\w]+)/i);
    if (videoMatch) {
      return { page: "note_detail" };
    }

    return { page: "explore" };
  } catch {
    return { page: "explore" };
  }
}

/** Douyin URL parsing */
export function parseDyPageContext(url: string): PageContext {
  try {
    const u = new URL(url);
    // /user/{sec_uid}
    const userMatch = u.pathname.match(/^\/user\/(MS4w[\w-]+|[\w-]{10,})/);
    if (userMatch) {
      return { page: "user", user_id: userMatch[1] };
    }
    // /video/{id} or /note/{id}
    const videoMatch = u.pathname.match(/^\/(video|note)\/(\d+)/);
    if (videoMatch) {
      return { page: "note_detail" };
    }
    return { page: "explore" };
  } catch {
    return { page: "explore" };
  }
}

/** Single entry point: pick the parser by platform */
export function parsePageContext(url: string, platform: PlatformKey = "xhs"): PageContext {
  switch (platform) {
    case "xhs":
      return parseXhsPageContext(url);
    case "bilibili":
      return parseBiliPageContext(url);
    case "douyin":
      return parseDyPageContext(url);
    default:
      return { page: "explore" };
  }
}
