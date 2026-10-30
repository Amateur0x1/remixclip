/**
 * Pi — `pi -p` (print mode, raw text stream). Prompt goes over stdin.
 * open-design uses `--mode rpc` (bidirectional JSON-RPC); here we take the simpler
 * print mode, trading tool-event granularity for robustness.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const piAgentDef: RuntimeAgentDef = {
  id: 'pi',
  name: 'Pi',
  bin: 'pi',
  binEnvOverride: 'PI_BIN',
  versionArgs: ['--version'],
  streamFormat: 'plain',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['-p'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createPlainTextParser,
};
