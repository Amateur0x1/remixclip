// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// New in RemixClip; no counterpart in social-media-sniffer@0a68863 (extension/).

/**
 * RemixClip bridge layer.
 *
 * There is no pairing handshake and no token: the daemon binds 127.0.0.1 only and gates the
 * library API by the chrome-extension origin, so the port IS the connection. The side panel runs
 * these calls against the loopback address:
 *   GET  /api/library/ping    liveness probe, returns { app: "remixclip" }
 *   POST /api/library/greet   heartbeat so the app can show "extension connected"
 *   POST /api/library/import  push exported content
 *
 * Every time the panel opens it probes the remembered port, then the default, then a few common
 * dev ports; when nothing answers the UI asks the user for the right port. Data never leaves the
 * machine.
 */

import type { PlatformKey } from "../types/common";

const CONFIG_KEY = "remixclip:config";

/** First port probed, and the daemon's preferred port (tools-dev and the desktop shell use it). */
export const DEFAULT_REMIXCLIP_PORT = 7456;

/** Extra ports probed after the remembered/default one; dev servers often take 7457+ next door. */
const PROBE_PORTS = [7457, 7458, 7459, 7460, 7461];

export interface RemixclipConfig {
  /** TCP port of the local daemon. No endpoint/token: the host is always 127.0.0.1. */
  port: number;
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

function isPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

/** Parse a user-typed port: `7456`, `127.0.0.1:7456` and `http://127.0.0.1:7456` all work. */
export function parsePort(value: unknown): number | null {
  if (typeof value === "number") return isPort(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const port = Number(trimmed);
    return isPort(port) ? port : null;
  }
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    if (!url.port) return null;
    return parsePort(url.port);
  } catch {
    return null;
  }
}

/** Port out of the pre-0.5 endpoint config, so an existing install keeps working after upgrade. */
function portFromLegacyEndpoint(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`);
    return url.port ? parsePort(url.port) : null;
  } catch {
    return null;
  }
}

export function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Remembered port first, then the default and its neighbours; deduplicated. */
export function portCandidates(preferred?: number | null): number[] {
  const candidates = [preferred, DEFAULT_REMIXCLIP_PORT, ...PROBE_PORTS];
  return [...new Set(candidates.filter((port): port is number => typeof port === "number" && isPort(port)))];
}

export async function loadRemixclipConfig(): Promise<RemixclipConfig> {
  const result = await chrome.storage.local.get(CONFIG_KEY);
  const stored = result[CONFIG_KEY] as { port?: unknown; endpoint?: unknown } | undefined;
  const port = parsePort(stored?.port) ?? portFromLegacyEndpoint(stored?.endpoint) ?? DEFAULT_REMIXCLIP_PORT;
  return { port };
}

export async function saveRemixclipConfig(config: RemixclipConfig): Promise<void> {
  // Only the port survives: old configs carried endpoint/token fields that are deliberately dropped.
  await chrome.storage.local.set({ [CONFIG_KEY]: { port: config.port } });
}

export async function pingRemixclip(port: number, timeoutMs = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${endpointFor(port)}/api/library/ping`, {
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

/**
 * Find the daemon: remember the last port that answered, then fall back to the default and the
 * usual neighbours. Returns null when nothing answers, which is the signal to ask the user.
 */
export async function detectRemixclip(preferred?: number | null): Promise<number | null> {
  for (const port of portCandidates(preferred)) {
    // Short timeout: localhost refuses instantly; a long one only makes a miss feel frozen.
    if (await pingRemixclip(port, 1500)) return port;
  }
  return null;
}

/** Best-effort heartbeat: lets the app's dialog show that this panel is connected. */
export async function greetRemixclip(port: number): Promise<void> {
  try {
    await fetch(`${endpointFor(port)}/api/library/greet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "RemixClip 素材助手" }),
    });
  } catch {
    // The heartbeat is cosmetic; a failed greet must never block capture or sending.
  }
}

export async function sendToRemixclip(
  port: number,
  payload: RemixclipExportPayload,
): Promise<{ itemCount: number; created: number; updated: number }> {
  const endpoint = endpointFor(port);
  let res: Response;
  try {
    res = await fetch(`${endpoint}/api/library/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // A dead daemon surfaces as "Failed to fetch", which tells the user nothing: sending is the
    // only export path, so name the port and the fix.
    throw new Error(`连不上 RemixClip（${endpoint}）：请确认应用已启动，或检查端口号是否正确`);
  }
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
