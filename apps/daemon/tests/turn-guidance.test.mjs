/**
 * Contract tests for the injected turn guidance (apps/daemon/src/turn-guidance.ts).
 * Runs against the compiled output: `pnpm --filter @remixclip/daemon build` first.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_TURN_GUIDANCE_CHARS, buildTurnGuidancePrompt } from '../dist/turn-guidance.js';

test('no guidance produces no prompt section', () => {
  for (const value of [undefined, null, '', '   ', '\n\t ']) {
    assert.equal(buildTurnGuidancePrompt(value), '', `expected '' for ${JSON.stringify(value)}`);
  }
});

test('non-string payloads are ignored instead of stringified', () => {
  for (const value of [42, { text: 'x' }, ['x'], true]) {
    assert.equal(buildTurnGuidancePrompt(value), '');
  }
});

test('guidance becomes its own section above the message', () => {
  const section = buildTurnGuidancePrompt('  只复刻前 5 秒，画面换成冷色调  ');
  assert.equal(section, '## 补充要求（优先满足）\n\n只复刻前 5 秒，画面换成冷色调');
  // The heading is what gives it priority over the base brief; the block must stay one section.
  assert.equal(section.split('\n## ').length, 1);
});

test('over-long guidance is capped', () => {
  const section = buildTurnGuidancePrompt('火'.repeat(MAX_TURN_GUIDANCE_CHARS + 500));
  assert.equal(section.length, '## 补充要求（优先满足）\n\n'.length + MAX_TURN_GUIDANCE_CHARS);
  assert.equal(section.endsWith('火'.repeat(50)), true);
});

test('trailing whitespace does not eat into the budget', () => {
  const text = '火'.repeat(MAX_TURN_GUIDANCE_CHARS);
  assert.equal(buildTurnGuidancePrompt(`${text}${' '.repeat(200)}`), `## 补充要求（优先满足）\n\n${text}`);
});
