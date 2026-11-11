import assert from 'node:assert/strict';
import test from 'node:test';
import { installerExtensions, parseTargets, planBuilder } from '../src/targets.js';

test('parseTargets defaults to the platform installer set', () => {
  assert.deepEqual(parseTargets('mac', 'all'), ['dmg', 'zip']);
  assert.deepEqual(parseTargets('win', undefined), ['nsis']);
  assert.deepEqual(parseTargets('linux', 'all'), ['appimage']);
});

test('parseTargets accepts dir alone and rejects mixed dir/installer', () => {
  assert.deepEqual(parseTargets('mac', 'dir'), ['dir']);
  assert.throws(() => parseTargets('mac', 'dir,dmg'), /cannot be combined/);
});

test('parseTargets rejects targets from another platform', () => {
  assert.throws(() => parseTargets('mac', 'nsis'), /not valid for mac/);
  assert.throws(() => parseTargets('win', 'dmg'), /not valid for win/);
});

test('planBuilder emits electron-builder flags for installers', () => {
  const plan = planBuilder({
    platform: 'mac',
    arch: 'arm64',
    targets: ['dmg', 'zip'],
    version: '0.2.0',
    releaseDir: '/tmp/release',
    publish: 'never',
    signed: false,
    notarize: false,
  });
  assert.equal(plan.dirOnly, false);
  assert.deepEqual(plan.args.slice(0, 2), ['exec', 'electron-builder']);
  assert.ok(plan.args.includes('--mac'));
  assert.ok(plan.args.includes('dmg'));
  assert.ok(plan.args.includes('zip'));
  assert.ok(plan.args.includes('--arm64'));
  assert.ok(plan.args.includes('--config.extraMetadata.version=0.2.0'));
  assert.ok(plan.args.includes('--config.directories.output=/tmp/release'));
  assert.ok(plan.args.includes('--config.mac.notarize=false'));
});

test('planBuilder uses --dir for unpacked builds', () => {
  const plan = planBuilder({
    platform: 'linux',
    arch: 'x64',
    targets: ['dir'],
    version: '0.2.0',
    releaseDir: '/tmp/release',
    publish: 'never',
    signed: false,
    notarize: false,
  });
  assert.equal(plan.dirOnly, true);
  assert.ok(plan.args.includes('--dir'));
  assert.ok(plan.args.includes('--linux'));
  assert.ok(!plan.args.includes('AppImage'));
});

test('installerExtensions maps targets to artifact extensions', () => {
  assert.deepEqual(installerExtensions(['dmg', 'zip']), ['.dmg', '.zip']);
  assert.deepEqual(installerExtensions(['nsis']), ['.exe']);
  assert.deepEqual(installerExtensions(['appimage', 'dir']), ['.AppImage']);
});
