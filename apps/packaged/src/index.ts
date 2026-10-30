import {
  launchSidecar,
  normalizeSidecarStamp,
  stopSidecar,
  APP_KEYS,
  SIDECAR_MODES,
  SIDECAR_SOURCES,
} from '@remixclip/sidecar';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const NAMESPACE = process.env.REMIXCLIP_NAMESPACE || 'default';

/**
 * Packaged entry point: starts daemon + web + desktop sidecars
 * in the correct order with proper lifecycle management.
 */
export async function startPackaged(options?: { namespace?: string }): Promise<void> {
  const namespace = options?.namespace || NAMESPACE;

  console.log(`[remixclip-packaged] starting with namespace: ${namespace}`);

  // 1. Start daemon
  const daemonStamp = normalizeSidecarStamp({
    app: APP_KEYS.DAEMON,
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
  });

  launchSidecar({
    app: APP_KEYS.DAEMON,
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
    cwd: REPO_ROOT,
  });

  console.log('[remixclip-packaged] daemon launched');

  // 2. Start web
  launchSidecar({
    app: APP_KEYS.WEB,
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
    cwd: REPO_ROOT,
  });

  console.log('[remixclip-packaged] web launched');

  // 3. Start desktop
  launchSidecar({
    app: APP_KEYS.DESKTOP,
    mode: SIDECAR_MODES.RUNTIME,
    namespace,
    source: SIDECAR_SOURCES.PACKAGED,
    cwd: REPO_ROOT,
  });

  console.log('[remixclip-packaged] desktop launched');
}

export async function stopPackaged(namespace?: string): Promise<void> {
  const ns = namespace || NAMESPACE;
  const stamps = [APP_KEYS.DAEMON, APP_KEYS.WEB, APP_KEYS.DESKTOP].map((app) =>
    normalizeSidecarStamp({ app, mode: SIDECAR_MODES.RUNTIME, namespace: ns })
  );
  await Promise.all(stamps.map((stamp) => stopSidecar(stamp)));
}

// Allow running directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startPackaged().catch((error) => {
    console.error('[remixclip-packaged] fatal:', error);
    process.exit(1);
  });
}