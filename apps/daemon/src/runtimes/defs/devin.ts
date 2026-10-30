/**
 * Devin for Terminal -- ACP mode.
 * `devin --permission-mode dangerous --respect-workspace-trust false acp`
 * opens an unattended ACP stdio session.
 */

import type { RuntimeAgentDef } from '../types.js';

export const devinAgentDef: RuntimeAgentDef = {
  id: 'devin',
  name: 'Devin for Terminal',
  bin: 'devin',
  binEnvOverride: 'DEVIN_BIN',
  versionArgs: ['--version'],
  models: ['adaptive', 'swe', 'opus', 'sonnet', 'codex', 'gpt', 'gemini'],
  docsUrl: 'https://cli.devin.ai/docs/models',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['--permission-mode', 'dangerous', '--respect-workspace-trust', 'false', 'acp'];
  },
  acp: { envFormat: 'array' },
};
