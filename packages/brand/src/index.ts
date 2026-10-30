/**
 * Single source of truth for brand constants.
 *
 * Every brand-derived directory name / IPC path / process match string must be imported from here;
 * business code must never hardcode literals such as the `.remixclip` data dir name or app name.
 * Renaming the product (e.g. remixclip → lynx) only requires changing the `BRAND_NAME` and
 * `APP_NAME` lines:
 *
 *   .remixclip            → .lynx             (daemon data dir)
 *   remixclip             → lynx or lynx-agent (IPC socket / data root / process matching;
 *                                              no fixed concatenation between app name and
 *                                              brand name)
 *
 * Note: npm package names (@remixclip/*) and pnpm --filter args are build-time identifiers;
 * TS cannot derive import paths at runtime, so a rename needs a global replace
 * (this comment is only a hint).
 */

/** Brand name — the single naming root. */
export const BRAND_NAME = 'remixclip';

/**
 * App name (IPC directory / data root / process-discovery match string).
 * The app name may equal the brand name or carry a product suffix; there is no required
 * concatenation between the two — just change this line to match the real product shape.
 */
export const APP_NAME = BRAND_NAME;

/** Default daemon runtime data dir name (lives under apps/, e.g. apps/.remixclip). */
export const DATA_DIR_NAME = `.${BRAND_NAME}`;
