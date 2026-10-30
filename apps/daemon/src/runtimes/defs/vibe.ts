/**
 * Mistral Vibe CLI — ACP mode (binary `vibe-acp`, no startup args).
 */

import type { RuntimeAgentDef } from '../types.js';

export const vibeAgentDef: RuntimeAgentDef = {
  id: 'vibe',
  name: 'Mistral Vibe CLI',
  bin: 'vibe-acp',
  binEnvOverride: 'VIBE_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://docs.mistral.ai/codestral/cli',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return [];
  },
  acp: { envFormat: 'array' },
};
