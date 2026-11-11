/**
 * @module port
 *
 * TCP port allocation, mirroring open-design's `@open-design/sidecar` port module:
 * a forced port is availability-checked and reserved before use, while an
 * unforced request probes an ephemeral listen (port 0) until it lands on a port
 * this run has not already claimed. Depends only on the shared net primitives.
 */

import type { Server } from 'node:net';

import { closeServer, listenOnPort } from './net.js';

/** How a port was chosen. */
export type PortSource = 'forced' | 'dynamic';

export interface PortAllocation {
  port: number;
  /** `forced` = the caller asked for this exact port; `dynamic` = probed. */
  source: PortSource;
}

export interface PortRequest {
  /** Loopback host to bind the probe on. */
  host?: string;
  /** Name used in error messages, e.g. `daemon`. */
  label?: string;
  /** A concrete port to claim; omitted/empty asks for a dynamic one. */
  port?: number | string | null;
  /** Ports already claimed by this run; never handed out twice. */
  reserved?: Set<number>;
}

/**
 * Parse a port value to an integer in 1..65535, or null when absent/empty.
 * Throws for anything else so a typo fails at startup instead of drifting.
 */
export function parsePortValue(
  value: number | string | null | undefined,
  label = 'runtime',
): number | null {
  if (value == null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${label} port must be an integer between 1 and 65535`);
  }
  return port;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error == null || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return code == null ? null : String(code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reserve a forced port after confirming it is free and unclaimed. */
async function allocateForcedPort(
  port: number,
  label: string,
  host: string,
  reserved: Set<number>,
): Promise<PortAllocation> {
  if (reserved.has(port)) {
    throw new Error(`forced ${label} port ${port} conflicts with another managed port`);
  }
  let server: Server | null = null;
  try {
    server = await listenOnPort(port, host);
  } catch (error) {
    throw new Error(
      `forced ${label} port ${port} is not available (${errorCode(error) ?? errorMessage(error)})`,
    );
  } finally {
    if (server) await closeServer(server);
  }
  reserved.add(port);
  return { port, source: 'forced' };
}

/** Probe ephemeral ports until a non-reserved one is found, then reserve it. */
async function allocateDynamicPort(
  label: string,
  host: string,
  reserved: Set<number>,
): Promise<PortAllocation> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await listenOnPort(0, host);
    const address = server.address();
    await closeServer(server);
    if (address == null || typeof address === 'string') {
      throw new Error(`failed to allocate dynamic ${label} port`);
    }
    if (!reserved.has(address.port)) {
      reserved.add(address.port);
      return { port: address.port, source: 'dynamic' };
    }
  }
  throw new Error(`failed to allocate dynamic ${label} port without conflict`);
}

/**
 * Allocate a port: the forced one when supplied, otherwise a dynamic one, always
 * recorded in `reserved` so the same run never hands it out twice.
 */
export async function allocatePort({
  host = '127.0.0.1',
  label = 'runtime',
  port,
  reserved = new Set<number>(),
}: PortRequest = {}): Promise<PortAllocation> {
  const forcedPort = parsePortValue(port, label);
  return forcedPort == null
    ? await allocateDynamicPort(label, host, reserved)
    : await allocateForcedPort(forcedPort, label, host, reserved);
}
