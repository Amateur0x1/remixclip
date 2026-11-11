/**
 * Kiro CLI — ACP mode (`kiro-cli acp`).
 *
 * Kiro signals the end of a turn with an explicit `turn_end` session/update rather than the
 * session/prompt RPC response, so completePromptOnTurnEnd must be enabled.
 */

import type { RuntimeAgentDef } from '../types.js';

export const kiroAgentDef: RuntimeAgentDef = {
  id: 'kiro',
  name: 'Kiro CLI',
  bin: 'kiro-cli',
  binEnvOverride: 'KIRO_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://kiro.dev/docs/cli/',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp'];
  },
  acp: { completePromptOnTurnEnd: true, envFormat: 'array' },
};
