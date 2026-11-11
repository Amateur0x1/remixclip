/**
 * DeepSeek Harness -- `dsh --profile open-design --stdio`.
 *
 * This is a structured profile stdio protocol (not CLI argv interaction):
 *   ready -> host sends an execute command -> session -> thinking/text/tool_* /usage ->
 *   result terminal state. See agent-protocol/dsh-profile for the session bridge.
 *
 * `--profile open-design` is the only profile bundle on the dsh side aligned with this
 * project's protocol; the user must first install that profile with the official installer.
 *
 * The model must be in `provider/id` form (the protocol requires it); `default` means
 * leave it to the account default.
 */

import type { RuntimeAgentDef } from '../types.js';

export const deepseekHarnessAgentDef: RuntimeAgentDef = {
  id: 'deepseek-harness',
  name: 'DeepSeek Harness',
  bin: 'dsh',
  binEnvOverride: 'DSH_BIN',
  versionArgs: ['--version'],
  models: [
    'deepseek/deepseek-chat',
    'deepseek/deepseek-reasoner',
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5.2',
  ],
  docsUrl: 'https://github.com/deepseek-ai/dsh',
  streamFormat: 'dsh-profile',
  promptViaStdin: false,
  buildArgs() {
    return ['--profile', 'open-design', '--stdio'];
  },
};
