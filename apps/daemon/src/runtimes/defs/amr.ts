/**
 * AMR -- the vela CLI's ACP stdio mode (`vela agent run`).
 *
 * vela spins up a private OpenCode server internally and forwards stream-json as
 * ACP JSON-RPC. Required environment (daemon process env or CLI env in settings):
 *   VELA_RUNTIME_KEY   OpenRouter (or compatible gateway) API key
 *   VELA_LINK_URL      OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1
 *   VELA_OPENCODE_BIN  optional: absolute path to opencode (when not on PATH)
 *
 * Model selection goes through ACP `session/set_model`: the simulated id `default`
 * skips that call and leaves it to the account-side default model. vela only accepts
 * ids present in its `vela models` catalog, hence only the recommended list.
 */

import type { RuntimeAgentDef } from '../types.js';

const MODELS = [
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'glm-5.1',
  'claude-sonnet-4.6',
  'gpt-5.2',
];

export const amrAgentDef: RuntimeAgentDef = {
  id: 'amr',
  name: 'AMR (vela)',
  bin: 'vela',
  binEnvOverride: 'VELA_BIN',
  versionArgs: ['--version'],
  models: MODELS,
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['agent', 'run'];
  },
  acp: { envFormat: 'array' },
};
