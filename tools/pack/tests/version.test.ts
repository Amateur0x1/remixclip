import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isPrerelease,
  normalizeVersion,
  parseVersion,
  releaseChannel,
  resolveVersion,
} from '../src/version.js';

test('parseVersion accepts x.y.z and prerelease suffixes', () => {
  assert.deepEqual(parseVersion('1.2.3'), { raw: '1.2.3', major: 1, minor: 2, patch: 3 });
  assert.equal(parseVersion('v1.2.3')?.raw, '1.2.3');
  assert.equal(parseVersion('1.2.3-beta.4')?.prerelease, 'beta.4');
});

test('parseVersion rejects malformed versions', () => {
  for (const input of ['1.2', '1.2.3.4', 'abc', '1.2.x', '']) {
    assert.equal(parseVersion(input), null, input);
  }
});

test('normalizeVersion strips the tag prefix and rejects garbage', () => {
  assert.equal(normalizeVersion('v0.2.0', 'test'), '0.2.0');
  assert.throws(() => normalizeVersion('nope', 'test'), /invalid version/);
});

test('prerelease detection drives the release channel', () => {
  assert.equal(isPrerelease('0.2.0-rc.1'), true);
  assert.equal(isPrerelease('0.2.0'), false);
  assert.equal(releaseChannel('0.2.0-rc.1'), 'prerelease');
  assert.equal(releaseChannel('0.2.0'), 'stable');
});

test('resolveVersion prefers cli, then env, then tag, then package.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remixclip-version-'));
  const packageFile = path.join(dir, 'package.json');
  writeFileSync(packageFile, JSON.stringify({ version: '9.9.9' }));

  assert.deepEqual(
    resolveVersion({ explicit: 'v1.2.3', env: { REMIXCLIP_VERSION: '2.0.0' }, refName: 'v3.0.0', packageFile }),
    { version: '1.2.3', source: 'cli' },
  );
  assert.deepEqual(
    resolveVersion({ env: { REMIXCLIP_VERSION: '2.0.0' }, refName: 'v3.0.0', packageFile }),
    { version: '2.0.0', source: 'env' },
  );
  assert.deepEqual(resolveVersion({ env: {}, refName: 'v3.0.0', packageFile }), {
    version: '3.0.0',
    source: 'tag',
  });
  assert.deepEqual(resolveVersion({ env: {}, refName: 'main', packageFile }), {
    version: '9.9.9',
    source: 'package.json',
  });
});
