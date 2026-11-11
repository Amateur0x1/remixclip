#!/usr/bin/env node
/**
 * [INPUT]: the compiled test directory produced by tsconfig.tests.json.
 * [OUTPUT]: `node --test` over every *.test.js, with an explicit file list for cross-version support.
 * [POS]: Node 22 does not accept a directory argument for --test; this keeps local and CI runs identical.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testDir = path.resolve('dist-tests', 'tests');
const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(testDir, name));

if (files.length === 0) {
  console.error(`[tools-pack] no compiled tests found in ${testDir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
