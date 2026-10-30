/**
 * Kilo — ACP mode (`kilo acp`).
 */

import type { RuntimeAgentDef } from '../types.js';

export const kiloAgentDef: RuntimeAgentDef = {
  id: 'kilo',
  name: 'Kilo',
  bin: 'kilo',
  binEnvOverride: 'KILO_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://kilocode.ai/docs',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp'];
  },
  acp: { envFormat: 'array' },
};
