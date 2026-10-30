/**
 * [INPUT]: OD_SIDECAR_IPC_PATH plus status/shutdown/register-web-url messages from tools-dev.
 * [OUTPUT]: a JSON-over-unix-socket control channel so `tools-dev stop` and `resolveDaemonUrl` get real answers.
 * [POS]: daemon side of the sidecar contract; previously only the client half existed.
 */
import net from 'node:net';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  isWindowsNamedPipePath,
  normalizeDaemonSidecarMessage,
  type DaemonStatusSnapshot,
} from '@remixclip/sidecar-proto';
import { listWebOrigins, registerWebOrigin } from './web-origins.js';

export interface DaemonIpcOptions {
  /** Loopback origin this daemon answers on, reported verbatim by STATUS. */
  url: string;
  /** Defaults to `OD_SIDECAR_IPC_PATH`; omitted when the daemon runs standalone. */
  ipcPath?: string;
  /** Reported over STATUS. RemixClip's daemon has no import-auth gate yet. */
  desktopAuthGateActive?: boolean;
  /** Invoked after SHUTDOWN has been acknowledged. */
  onShutdown?: () => void;
}

export function daemonStatusSnapshot(
  options: DaemonIpcOptions,
  now: Date = new Date(),
): DaemonStatusSnapshot {
  return {
    pid: process.pid,
    state: 'running',
    trustedWebOriginPort: firstOriginPort(),
    updatedAt: now.toISOString(),
    url: options.url,
    desktopAuthGateActive: options.desktopAuthGateActive ?? false,
  };
}

function firstOriginPort(): number | null {
  const [origin] = listWebOrigins();
  if (!origin) return null;
  const port = Number(new URL(origin).port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/**
 * Starts the control socket. Returns null when the daemon was started without a
 * sidecar stamp (direct `node dist/cli.js`) or when another server already owns
 * the socket — in both cases the HTTP API keeps working, only IPC is absent.
 */
export async function startDaemonIpc(options: DaemonIpcOptions): Promise<net.Server | null> {
  const ipcPath = options.ipcPath ?? process.env[SIDECAR_ENV.IPC_PATH];
  if (!ipcPath) return null;

  if (await isSocketLive(ipcPath)) {
    console.warn(`[remixclip] sidecar IPC ${ipcPath} is already served by another process; skipping registration`);
    return null;
  }

  const namedPipe = isWindowsNamedPipePath(ipcPath);
  if (!namedPipe) {
    mkdirSync(path.dirname(ipcPath), { recursive: true });
    // A daemon killed with SIGKILL leaves the socket file behind; unlink it so
    // bind() does not fail with EADDRINUSE on the next start.
    if (existsSync(ipcPath)) await rm(ipcPath, { force: true });
  }

  const server = net.createServer((socket) => handleConnection(socket, options));
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(ipcPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  server.on('close', () => {
    if (!namedPipe) void rm(ipcPath, { force: true }).catch(() => {});
  });
  // The Express server keeps the event loop alive; the control socket must not.
  server.unref();
  console.log(`[remixclip] sidecar IPC listening on ${ipcPath}`);
  return server;
}

function handleConnection(socket: net.Socket, options: DaemonIpcOptions): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => socket.destroy());
  socket.on('data', (chunk: string) => {
    buffer += chunk;
  });
  socket.on('end', () => {
    const { reply, shutdown } = dispatch(buffer, options);
    socket.end(JSON.stringify(reply), () => {
      if (shutdown) options.onShutdown?.();
    });
  });
}

function dispatch(
  raw: string,
  options: DaemonIpcOptions,
): { reply: unknown; shutdown: boolean } {
  try {
    // The client envelope carries `stamp` for the server to identify itself with;
    // the contract normalizers only accept `type`/`input`, so strip extras first.
    const envelope = JSON.parse(raw) as { type?: unknown; input?: unknown };
    const message = normalizeDaemonSidecarMessage({
      type: envelope.type,
      ...(envelope.input === undefined ? {} : { input: envelope.input }),
    });
    switch (message.type) {
      case SIDECAR_MESSAGES.STATUS:
        return { reply: daemonStatusSnapshot(options), shutdown: false };
      case SIDECAR_MESSAGES.SHUTDOWN:
        return { reply: { accepted: true }, shutdown: true };
      case SIDECAR_MESSAGES.REGISTER_WEB_URL: {
        const origin = registerWebOrigin(message.input.url);
        return {
          reply: origin
            ? { accepted: true, origin }
            : { accepted: false, error: `not a valid loopback origin: ${message.input.url}` },
          shutdown: false,
        };
      }
      default:
        return { reply: { accepted: false, error: 'unsupported message' }, shutdown: false };
    }
  } catch (error) {
    return {
      reply: { accepted: false, error: error instanceof Error ? error.message : String(error) },
      shutdown: false,
    };
  }
}

/** True when something already accepts connections on `socketPath`. */
async function isSocketLive(socketPath: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (live: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.setTimeout(timeoutMs, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}
