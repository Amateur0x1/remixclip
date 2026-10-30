/**
 * DeepSeek TUI -- `deepseek exec --auto <prompt>`.
 *
 * exec mode requires the prompt as a positional argument (clap-required, no `-`
 * sentinel), so it can only go through argv; `--auto` turns on auto-approve, avoiding
 * getting stuck on an interactive confirmation without a TTY.
 *
 * `--json` is not passed: the default plain-text stdout is streaming, whereas `--json`
 * accumulates until the turn ends and emits one summary object, sacrificing real-time
 * output. Tool calls go through stderr.
 *
 * After the upstream CodeWhale rename, the same dispatcher also ships as `codewhale`,
 * which serves as a fallback bin.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const deepseekAgentDef: RuntimeAgentDef = {
  id: 'deepseek',
  name: 'DeepSeek TUI',
  bin: 'deepseek',
  fallbackBins: ['codewhale'],
  binEnvOverride: 'DEEPSEEK_BIN',
  versionArgs: ['--version'],
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  streamFormat: 'plain',
  promptViaStdin: false,
  // prompt goes as a positional arg; leave headroom for the Windows CreateProcess limit
  maxPromptArgBytes: 30_000,
  buildArgs({ model, prompt }) {
    const args = ['exec', '--auto'];
    if (model && model !== 'default') args.push('--model', model);
    args.push(prompt ?? '');
    return args;
  },
  createParser: createPlainTextParser,
};
