/**
 * System API types — the daemon's own runtime identity.
 *
 * The settings drawer shows this so the user can see (and copy) the exact loopback endpoint
 * the app and the browser extension talk to, instead of guessing the port.
 */

/** GET /api/system/info */
export interface DaemonRuntimeInfo {
  /** OS process id of the running daemon. */
  pid: number;
  /** TCP port the daemon is bound to; null only before the listener is up. */
  port: number | null;
  /** Loopback endpoint derived from the request host and the bound port. */
  endpoint: string | null;
  /** Web origin the daemon currently trusts (env seed or a live register-web-url). */
  webOrigin: string | null;
}

/**
 * GET /api/system/extension — metadata of the browser companion build the daemon can hand out.
 *
 * The library shows a download button that must not fail silently: this snapshot says up front
 * whether a build exists (`available`), so the UI can explain "run pnpm extension:build"
 * instead of serving a broken zip. `null` fields never appear while `available` is true.
 */
export interface ExtensionPackageInfo {
  available: boolean;
  /** manifest_version 3 `version` field of the packaged build. */
  version: string | null;
  /** Download file name, e.g. `remixclip-companion-0.4.0.zip`. */
  fileName: string | null;
  /** Zip size in bytes; the dialog prints it next to the version. */
  size: number | null;
  /** Wall-clock time of the newest file in the build (ISO 8601). */
  builtAt: string | null;
}
