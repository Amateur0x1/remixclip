/**
 * Amp CLI -- `amp -x --stream-json` (headless, emits Claude Code-compatible JSONL).
 *
 * The prompt goes through stdin (the official `echo "..." | amp -x` form), so there is
 * no argv length limit. `--dangerously-allow-all` is the auto-approve switch for
 * unattended mode; without it every tool call blocks waiting for human confirmation.
 *
 * Amp has no `--model`; the model is chosen via the agent's `--mode` (smart / deep /
 * rush), so here the model dropdown ids map directly to `--mode`.
 */

import type { RuntimeAgentDef } from '../types.js';
import { claudeAgentDef } from './claude.js';

const AMP_MODES = new Set(['smart', 'deep', 'rush']);

export const ampAgentDef: RuntimeAgentDef = {
  id: 'amp',
  name: 'Amp',
  bin: 'amp',
  binEnvOverride: 'AMP_BIN',
  versionArgs: ['--version'],
  models: ['smart', 'deep', 'rush'],
  docsUrl: 'https://ampcode.com',
  // The wire frames are Claude Code's stream-json; reuse the claude parser directly
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['-x', '--stream-json', '--dangerously-allow-all'];
    if (model && AMP_MODES.has(model)) args.push('--mode', model);
    return args;
  },
  sessionIdFromLine(line) {
    return claudeAgentDef.sessionIdFromLine!(line);
  },
  createParser() {
    return claudeAgentDef.createParser!();
  },
};
