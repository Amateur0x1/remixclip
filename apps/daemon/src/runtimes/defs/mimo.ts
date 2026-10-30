/**
 * MiMo Code — `mimo run --format json` (OpenCode-compatible event stream).
 */

import type { RuntimeAgentDef } from '../types.js';
import { createOpenCodeParser } from './opencode.js';

export const mimoAgentDef: RuntimeAgentDef = {
  id: 'mimo',
  name: 'MiMo Code',
  bin: 'mimo',
  binEnvOverride: 'MIMO_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://github.com/XiaoMi/mimo-code',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['run', '--format', 'json'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createOpenCodeParser,
};
