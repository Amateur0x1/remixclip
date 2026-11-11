/**
 * Antigravity (`agy`) -- headless stream-json.
 *
 * The prompt goes through stdin as a single NDJSON user frame (the official channel
 * for agy >= 1.1.15):
 *   agy --input-format stream-json --output-format stream-json
 * `-p <text>` completely ignores stdin, and `-p -` is taken as the literal "-", so
 * this is the only usable form.
 *
 * Model: agy still has no `--model`; the selection lives in the `model` field of
 * `~/.gemini/antigravity-cli/settings.json`, re-read on every headless start. So
 * buildArgs writes the chosen label into that file before spawn; `default` means
 * leave the file alone (keep whatever the user last picked in the agy TUI).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { RuntimeAgentDef } from '../types.js';
import { antigravitySessionIdFromLine, createAntigravityParser } from './json-streams.js';

const SETTINGS_PATH = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

/** Persist the model label into agy's settings.json (best-effort; failures don't block spawn). */
function writeModelSelection(label: string): void {
  try {
    let existing: Record<string, unknown> = {};
    if (existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    }
    existing.model = label;
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(existing, null, 2)}\n`);
  } catch {
    // When settings.json is unwritable, fall back to agy's own default model
  }
}

function encodeStdinPrompt(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

export const antigravityAgentDef: RuntimeAgentDef = {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  binEnvOverride: 'AGY_BIN',
  versionArgs: ['--version'],
  // The label is agy's server-side enum; custom ids silently hit a cache miss
  models: [
    'Gemini 3.1 Pro (High)',
    'Gemini 3.1 Pro (Low)',
    'Gemini 3.5 Flash (High)',
    'Gemini 3.5 Flash (Medium)',
    'Gemini 3.5 Flash (Low)',
    'Claude Sonnet 4.6 (Thinking)',
    'Claude Opus 4.6 (Thinking)',
    'GPT-OSS 120B (Medium)',
  ],
  docsUrl: 'https://antigravity.google/docs/cli-overview',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  encodeStdinPrompt,
  buildArgs({ model }) {
    if (model && model !== 'default') writeModelSelection(model);
    return [
      // Unattended runs have no interactive approval channel
      '--dangerously-skip-permissions',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ];
  },
  sessionIdFromLine: antigravitySessionIdFromLine,
  createParser: createAntigravityParser,
};
