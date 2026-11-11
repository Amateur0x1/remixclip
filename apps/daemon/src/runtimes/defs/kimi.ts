/**
 * Kimi CLI (Moonshot) — ACP protocol.
 * See open-design defs/kimi.ts: `kimi acp`.
 */

import type { RuntimeAgentDef } from '../types.js';

export const kimiAgentDef: RuntimeAgentDef = {
  id: 'kimi',
  name: 'Kimi CLI',
  bin: 'kimi',
  docsUrl: 'https://github.com/MoonshotAI/kimi-cli',
  binEnvOverride: 'KIMI_BIN',
  versionArgs: ['--version'],
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp'];
  },
};
