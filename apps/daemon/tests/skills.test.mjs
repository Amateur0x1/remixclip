/**
 * Contract tests for the bundled skill catalog (apps/daemon/src/skills.ts).
 * Runs against the compiled output: `pnpm --filter @remixclip/daemon build` first.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSkillsPrompt,
  loadSkillCatalog,
  materializeProjectSkills,
  resetSkillCatalog,
} from '../dist/skills.js';

const ENV_KEY = 'OD_SKILLS_DIR';

function withSkillsDir(dir, run) {
  const previous = process.env[ENV_KEY];
  process.env[ENV_KEY] = dir;
  resetSkillCatalog();
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
    resetSkillCatalog();
  }
}

test('the vendored library is resolvable from the repo layout', () => {
  const skills = loadSkillCatalog();
  assert.ok(skills.length >= 5, `expected a populated catalog, got ${skills.length}`);
  for (const skill of skills) {
    assert.match(skill.id, /^[a-z0-9-]+$/);
    assert.ok(skill.summary.length > 0);
    assert.ok(skill.skillFile.endsWith(path.join(skill.id, 'SKILL.md')), skill.skillFile);
  }
  const ids = skills.map((skill) => skill.id);
  assert.ok(ids.includes('hyperframes-animation'), 'the motion knowledge base must be bundled');
});

test('the prompt names every skill and its absolute SKILL.md path', () => {
  const prompt = buildSkillsPrompt();
  assert.match(prompt, /## 可参考的专业技能/);
  for (const skill of loadSkillCatalog()) {
    assert.ok(prompt.includes(`\`${skill.id}\``), `missing ${skill.id}`);
    assert.ok(prompt.includes(skill.skillFile), `missing path for ${skill.id}`);
  }
  // Prompt text, not documentation: keep it small enough to ship on every turn.
  assert.ok(prompt.length < 4000, `prompt grew to ${prompt.length} chars`);
});

test('entries whose SKILL.md is missing are dropped instead of advertised', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remixclip-skills-'));
  mkdirSync(path.join(dir, 'present'));
  writeFileSync(path.join(dir, 'present', 'SKILL.md'), '# present\n');
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      skills: [
        { id: 'present', summary: 'ships' },
        { id: 'absent', summary: 'file was never vendored' },
        { id: '', summary: 'no id' },
        { summary: 'no id at all' },
      ],
    }),
  );

  withSkillsDir(dir, () => {
    assert.deepEqual(loadSkillCatalog().map((skill) => skill.id), ['present']);
  });
});

test('a malformed manifest degrades to no skills instead of throwing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'remixclip-skills-bad-'));
  writeFileSync(path.join(dir, 'manifest.json'), '{ not json');

  withSkillsDir(dir, () => {
    assert.deepEqual(loadSkillCatalog(), []);
    assert.equal(buildSkillsPrompt(), '');
  });
});

test('the library is materialized into the project workspace once', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'remixclip-project-'));

  const target = materializeProjectSkills(cwd);
  assert.equal(target, path.join(cwd, '.remixclip', 'skills'));
  assert.ok(existsSync(path.join(target, 'manifest.json')));
  assert.ok(existsSync(path.join(target, 'hyperframes-animation', 'SKILL.md')));

  // Prompt paths must point at the project-local copy the sandbox can read.
  assert.ok(buildSkillsPrompt(target).includes(target));

  // Second call reuses the copy instead of re-copying the library.
  assert.equal(materializeProjectSkills(cwd), target);
});
