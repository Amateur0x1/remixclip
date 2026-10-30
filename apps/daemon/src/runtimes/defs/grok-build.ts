/**
 * Grok Build (xAI's official CLI, `grok`) — `--prompt-file <PATH>`.
 *
 * Since v0.1.212+, `-p/--single` must take an argv value and no longer reads piped stdin, while
 * the composed prompt often exceeds the safe argv budget, so we use the CLI's own prompt-file
 * channel.
 *
 * Headless runs must also disable plan mode and auto-approve everything (`--no-plan`
 * `--always-approve`), otherwise file-write requests get cancelled by permissions while the
 * process still exits 0.
 *
 * There is no stable structured output yet, so plain first (single-turn text reply, tool events
 * are not streamed).
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

function supportsReasoningEffort(model: string | null | undefined): boolean {
  if (!model || model === 'default' || model === 'grok-build') return false;
  return /reasoning/i.test(model);
}

export const grokBuildAgentDef: RuntimeAgentDef = {
  id: 'grok-build',
  name: 'Grok Build',
  bin: 'grok',
  binEnvOverride: 'GROK_BIN',
  versionArgs: ['--version'],
  models: [
    'grok-build',
    'grok-4.3',
    'grok-4.20-reasoning',
    'grok-4.20-non-reasoning',
    'grok-4.20-multi-agent',
  ],
  docsUrl: 'https://x.ai/cli',
  streamFormat: 'plain',
  promptViaStdin: false,
  promptViaFile: true,
  buildArgs({ model, promptFilePath }) {
    if (!promptFilePath) throw new Error('grok-build 需要 prompt 临时文件');
    const args = ['--prompt-file', promptFilePath, '--no-plan', '--always-approve'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createPlainTextParser,
};
