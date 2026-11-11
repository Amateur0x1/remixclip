import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectRelease, listArtifactFiles, sha256File } from '../src/collect.js';
import { createLogger } from '../src/context.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'remixclip-collect-'));
}

test('sha256File matches a known digest', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'hello.txt');
  writeFileSync(file, 'hello');
  assert.equal(
    await sha256File(file),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  );
});

test('listArtifactFiles keeps installers and update metadata, drops builder internals', () => {
  const dir = tempDir();
  for (const name of [
    'RemixClip-0.2.0-mac-arm64.dmg',
    'RemixClip-0.2.0-mac-arm64.zip',
    'RemixClip-0.2.0-mac-arm64.dmg.blockmap',
    'latest-mac.yml',
    'builder-debug.yml',
    'SHA256SUMS-mac-arm64.txt',
    'RemixClip-0.2.0-mac-arm64-manifest.json',
  ]) {
    writeFileSync(path.join(dir, name), 'x');
  }
  mkdirSync(path.join(dir, 'mac-arm64'));

  assert.deepEqual(listArtifactFiles(dir), [
    'RemixClip-0.2.0-mac-arm64.dmg',
    'RemixClip-0.2.0-mac-arm64.dmg.blockmap',
    'RemixClip-0.2.0-mac-arm64.zip',
    'latest-mac.yml',
  ]);
});

test('collectRelease writes a manifest and checksums for every artifact', async () => {
  const releaseDir = tempDir();
  writeFileSync(path.join(releaseDir, 'RemixClip-0.2.0-mac-arm64.dmg'), 'installer');
  writeFileSync(path.join(releaseDir, 'RemixClip-0.2.0-mac-arm64.zip'), 'archive');

  const result = await collectRelease({
    platform: 'mac',
    arch: 'arm64',
    version: '0.2.0',
    nodeVersion: '24.18.0',
    releaseDir,
    logger: createLogger(false),
  });

  assert.equal(result.manifest.artifacts.length, 2);
  assert.equal(result.manifest.channel, 'stable');
  assert.equal(result.manifest.node, '24.18.0');
  assert.ok(result.manifest.artifacts.every((artifact) => artifact.sha256.length === 64));

  const checksums = readFileSync(result.checksumsPath, 'utf8').trim().split('\n');
  assert.equal(checksums.length, 2);
  assert.ok(checksums.every((line) => /^[a-f0-9]{64} {2}RemixClip-/.test(line)));

  const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8')) as typeof result.manifest;
  assert.equal(manifest.checksumsFile, 'SHA256SUMS-mac-arm64.txt');
});

test('collectRelease accepts electron-builder arch spellings such as linux x86_64', async () => {
  const releaseDir = tempDir();
  // The AppImage target names x64 as x86_64; collection must not reject its own output.
  writeFileSync(path.join(releaseDir, 'RemixClip-0.2.0-linux-x86_64.AppImage'), 'appimage');

  const result = await collectRelease({
    platform: 'linux',
    arch: 'x64',
    version: '0.2.0',
    nodeVersion: '24.18.0',
    releaseDir,
    logger: createLogger(false),
  });

  assert.deepEqual(result.manifest.artifacts.map((artifact) => artifact.file), [
    'RemixClip-0.2.0-linux-x86_64.AppImage',
  ]);
  assert.equal(result.manifest.checksumsFile, 'SHA256SUMS-linux-x64.txt');
});

test('collectRelease still rejects artifacts from another version', async () => {
  const releaseDir = tempDir();
  writeFileSync(path.join(releaseDir, 'RemixClip-0.1.0-linux-x86_64.AppImage'), 'stale');

  await assert.rejects(
    collectRelease({
      platform: 'linux',
      arch: 'x64',
      version: '0.2.0',
      nodeVersion: '24.18.0',
      releaseDir,
      logger: createLogger(true),
    }),
    /does not belong to 0\.2\.0\/linux\/x64/,
  );
});

test('collectRelease fails loudly when packaging produced nothing', async () => {
  const releaseDir = tempDir();
  await assert.rejects(
    collectRelease({
      platform: 'linux',
      arch: 'x64',
      version: '0.2.0',
      nodeVersion: '24.18.0',
      releaseDir,
      logger: createLogger(true),
    }),
    /no installers found/,
  );
});
