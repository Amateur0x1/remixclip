import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanPlatformArtifacts, parseSignMode, resolveSigning } from '../src/builder.js';
import { createLogger } from '../src/context.js';

test('cleanPlatformArtifacts removes installers and blockmaps for one platform/arch only', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remixclip-clean-'));
  for (const name of [
    'RemixClip-0.1.0-mac-arm64.dmg',
    'RemixClip-0.1.0-mac-arm64.dmg.blockmap',
    'RemixClip-0.1.0-mac-arm64.zip',
    'RemixClip-0.1.0-mac-arm64.zip.blockmap',
    'RemixClip-0.1.0-mac-arm64-manifest.json',
    'SHA256SUMS-mac-arm64.txt',
    'RemixClip-0.1.0-mac-x64.dmg',
    'RemixClip-0.1.0-win-x64.exe',
  ]) {
    writeFileSync(path.join(dir, name), 'x');
  }

  const removed = cleanPlatformArtifacts(dir, 'mac', 'arm64').sort();
  assert.deepEqual(removed, [
    'RemixClip-0.1.0-mac-arm64.dmg',
    'RemixClip-0.1.0-mac-arm64.dmg.blockmap',
    'RemixClip-0.1.0-mac-arm64.zip',
    'RemixClip-0.1.0-mac-arm64.zip.blockmap',
  ]);
  assert.deepEqual(readdirSync(dir).sort(), [
    'RemixClip-0.1.0-mac-arm64-manifest.json',
    'RemixClip-0.1.0-mac-x64.dmg',
    'RemixClip-0.1.0-win-x64.exe',
    'SHA256SUMS-mac-arm64.txt',
  ]);
});

test('parseSignMode accepts auto/always/never and bare --sign', () => {
  assert.equal(parseSignMode(undefined), 'auto');
  assert.equal(parseSignMode('auto'), 'auto');
  assert.equal(parseSignMode('never'), 'never');
  assert.equal(parseSignMode(true), 'always');
  assert.throws(() => parseSignMode('sometimes'), /invalid --sign/);
});

test('resolveSigning stays unsigned without certificate material', () => {
  const saved = { link: process.env.CSC_LINK, name: process.env.CSC_NAME };
  delete process.env.CSC_LINK;
  delete process.env.CSC_NAME;
  try {
    assert.deepEqual(resolveSigning('mac', 'auto', false, createLogger(true)), {
      signed: false,
      notarize: false,
    });
    assert.throws(() => resolveSigning('mac', 'auto', true, createLogger(true)), /requires a signing certificate/);
    assert.throws(() => resolveSigning('mac', 'always', false, createLogger(true)), /requires CSC_LINK/);
  } finally {
    if (saved.link !== undefined) process.env.CSC_LINK = saved.link;
    if (saved.name !== undefined) process.env.CSC_NAME = saved.name;
  }
});

test('resolveSigning refuses notarization without Apple credentials', () => {
  const previous = process.env.CSC_LINK;
  process.env.CSC_LINK = '/tmp/fake.p12';
  delete process.env.APPLE_ID;
  delete process.env.APPLE_APP_SPECIFIC_PASSWORD;
  delete process.env.APPLE_TEAM_ID;
  try {
    assert.throws(
      () => resolveSigning('mac', 'auto', true, createLogger(true)),
      /APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID/,
    );
  } finally {
    if (previous === undefined) delete process.env.CSC_LINK;
    else process.env.CSC_LINK = previous;
  }
});
