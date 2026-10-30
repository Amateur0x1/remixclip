// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// New in RemixClip; no counterpart in social-media-sniffer@0a68863 (extension/).

/**
 * RemixClip bridge layer.
 *
 * The extension still runs inside Chrome and talks to the RemixClip daemon only over the
 * local loopback address:
 *   GET  /api/library/ping    liveness probe
 *   POST /api/library/pair    exchange a 6-digit pairing code for a device token
 *   POST /api/library/import  push exported content with the token
 *
 * No other endpoint is touched besides pairing and import; data never leaves the machine.
 */

import type { PlatformKey } from "../types/common";

const CONFIG_KEY = "remixclip:config";
export const DEFAULT_REMIXCLIP_ENDPOINT = "http://127.0.0.1:7456";

export interface RemixclipConfig {
  endpoint: string;
  token: string;
  deviceName?: string;
  pairedAt?: number;
}

export interface RemixclipPairResult {
  token: string;
  device: { id: string; name: string; createdAt: number };
  endpoint: string;
}

export interface RemixclipExportPayload {
  platform: PlatformKey;
  exported_at: string;
  exported_count?: number;
  notes?: unknown[];
  cards?: unknown[];
  users?: unknown[];
  comments?: Record<string, unknown>;
}

function normalizeEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_REMIXCLIP_ENDPOINT;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export async function loadRemixclipConfig(): Promise<RemixclipConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  const stored = result[CONFIG_KEY] as Partial<RemixclipConfig> | undefined;
  return {
    endpoint: normalizeEndpoint(stored?.endpoint ?? DEFAULT_REMIXCLIP_ENDPOINT),
    token: stored?.token ?? "",
    deviceName: stored?.deviceName,
    pairedAt: stored?.pairedAt,
  };
}

export async function saveRemixclipConfig(config: RemixclipConfig): Promise<void> {
  await chrome.storage.local.set({
    [CONFIG_KEY]: { ...config, endpoint: normalizeEndpoint(config.endpoint) },
  });
}

export async function clearRemixclipConfig(): Promise<RemixclipConfig> {
  const next: RemixclipConfig = { endpoint: DEFAULT_REMIXCLIP_ENDPOINT, token: "" };
  await saveRemixclipConfig(next);
  return next;
}

export async function pingRemixclip(endpoint: string, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalizeEndpoint(endpoint)}/api/library/ping`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { app?: string };
    return data.app === "remixclip";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function pairRemixclip(endpoint: string, code: string): Promise<RemixclipPairResult> {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/api/library/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), client: "RemixClip 素材助手" }),
  });
  const data = await res.json().catch(() => null) as (Partial<RemixclipPairResult> & { error?: string }) | null;
  if (!res.ok || !data?.token) {
    throw new Error(data?.error ?? `配对失败：HTTP ${res.status}`);
  }
  return data as RemixclipPairResult;
}

/**
 * Pair without a code. The daemon only accepts this from a chrome-extension origin AND while the
 * user has just clicked 「开启自动连接」 in the RemixClip library dialog (2-minute window).
 */
export async function pairRemixclipAuto(
  endpoint: string,
  client = "RemixClip 素材助手",
): Promise<RemixclipPairResult> {
  const res = await fetch(`${normalizeEndpoint(endpoint)}/api/library/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ auto: true, client }),
  });
  const data = await res.json().catch(() => null) as (Partial<RemixclipPairResult> & { error?: string }) | null;
  if (!res.ok || !data?.token) {
    throw new Error(data?.error ?? `自动连接失败：HTTP ${res.status}`);
  }
  return data as RemixclipPairResult;
}

export async function sendToRemixclip(
  config: RemixclipConfig,
  payload: RemixclipExportPayload,
): Promise<{ itemCount: number; created: number; updated: number }> {
  if (!config.token) throw new Error("还没有连接 RemixClip，请先配对");
  const res = await fetch(`${normalizeEndpoint(config.endpoint)}/api/library/import`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => null) as {
    error?: string;
    batch?: { itemCount: number };
    created?: number;
    updated?: number;
  } | null;
  if (!res.ok) {
    throw new Error(data?.error ?? `发送失败：HTTP ${res.status}`);
  }
  return {
    itemCount: data?.batch?.itemCount ?? 0,
    created: data?.created ?? 0,
    updated: data?.updated ?? 0,
  };
}
