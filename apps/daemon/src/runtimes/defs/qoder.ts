/**
 * Qoder CLI — `qodercli -p --output-format stream-json --yolo`.
 *
 * Print mode exits after a single turn: prompt goes over stdin to dodge the argv limit, `-w`
 * pins the workspace, and `--yolo` is the unattended auto-approve switch.
 * Auth is owned by Qoder CLI itself (the persisted state from `qodercli login`, or the
 * QODER_PERSONAL_ACCESS_TOKEN env var).
 */

import type { RuntimeAgentDef } from '../types.js';
import { createQoderParser } from './json-streams.js';

export const qoderAgentDef: RuntimeAgentDef = {
  id: 'qoder',
  name: 'Qoder CLI',
  bin: 'qodercli',
  binEnvOverride: 'QODER_BIN',
  versionArgs: ['--version'],
  models: ['lite', 'efficient', 'auto', 'performance', 'ultimate'],
  docsUrl: 'https://qoder.com/docs/cli',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, cwd }) {
    const args = ['-p', '--output-format', 'stream-json', '--yolo'];
    if (cwd) args.push('-w', cwd);
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createQoderParser,
};
