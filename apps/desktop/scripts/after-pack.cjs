/**
 * [INPUT]: electron-builder's afterPack context (`appOutDir`, `electronPlatformName`).
 * [OUTPUT]: a self-consistent ad-hoc signature on the .app when no Apple identity is configured.
 * [POS]: The gap between "electron-builder skipped codesign" and "macOS will open this app".
 *
 * Why this exists: Electron ships its binaries with a linker-only ad-hoc signature. When no
 * Developer ID is present, electron-builder skips codesign entirely, so the bundle keeps
 * Electron's signature while its contents (renamed executable, rewritten Info.plist) have already
 * changed. The seal no longer matches, and macOS reports the app as *damaged* — not merely
 * unsigned — which no amount of "Open Anyway" can fix.
 *
 * Re-signing the finished bundle ad-hoc regenerates `_CodeSignature/CodeResources`, so the app is
 * internally consistent again. Gatekeeper still refuses a first launch without notarization, but
 * the user gets the normal "unidentified developer" prompt (right-click → Open) instead of a
 * broken bundle. A real identity, when configured, signs right after this hook and wins.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ENTITLEMENTS = path.join(__dirname, '..', 'build', 'entitlements.mac.plist');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // A configured identity signs after this hook; signing now would only be replaced.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // `--deep` keeps this a single call: the bundle carries helpers, frameworks and a Node binary
  // that all need the same ad-hoc signature, and signing them one by one buys nothing here.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', ENTITLEMENTS, appPath],
    { stdio: 'inherit' },
  );

  console.log(`[after-pack] ad-hoc signed ${appName} (no Apple identity configured)`);
};
