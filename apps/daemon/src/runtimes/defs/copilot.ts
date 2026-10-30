/**
 * GitHub Copilot CLI -- `copilot --output-format json`.
 *
 * The prompt doesn't use `-p`; it goes straight to stdin (the official `cat prompt.txt
 * | copilot --model <id>` form); `-p <body>` would cram the whole prompt into a single
 * argv, which exceeds the CreateProcess limit on Windows.
 * `--allow-all-tools` is the auto-approve switch for unattended runs; without it every
 * tool call blocks.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createCopilotParser } from './json-streams.js';

export const copilotAgentDef: RuntimeAgentDef = {
  id: 'copilot',
  name: 'GitHub Copilot CLI',
  bin: 'copilot',
  binEnvOverride: 'COPILOT_BIN',
  versionArgs: ['--version'],
  // No models subcommand; this is a hint list based on actual testing, and any id can
  // be typed in
  models: ['claude-sonnet-4.6', 'gpt-5.2'],
  docsUrl: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['--allow-all-tools', '--output-format', 'json'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createCopilotParser,
};
