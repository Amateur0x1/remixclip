/**
 * Hermes CLI (xAI / Nous) — ACP protocol.
 * See open-design defs/hermes.ts: `hermes acp --accept-hooks`.
 */

import type { RuntimeAgentDef } from '../types.js';

export const hermesAgentDef: RuntimeAgentDef = {
  id: 'hermes',
  name: 'Hermes',
  bin: 'hermes',
  binEnvOverride: 'HERMES_BIN',
  versionArgs: ['--version'],
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp', '--accept-hooks'];
  },
};
