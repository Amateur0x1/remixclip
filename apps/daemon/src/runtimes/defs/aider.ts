/**
 * Aider -- `aider --message <prompt>` (one-shot Q&A mode).
 *
 * Aider's `--message` / `--message-file` do not accept `-` as a stdin sentinel,
 * so the prompt can only go through argv; also pass the suppression flags required
 * in a no-TTY environment:
 *   --yes-always               skip per-action confirmation
 *   --no-pretty                strip ANSI so stdout can be parsed as plain text
 *   --no-git / --no-auto-commits  the workdir is not the user's git repo; commits are moot
 *   --no-suggest-shell-commands   avoid interactive follow-up questions
 *   --no-show-model-warnings      suppress the model compatibility banner
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const aiderAgentDef: RuntimeAgentDef = {
  id: 'aider',
  name: 'Aider',
  bin: 'aider',
  binEnvOverride: 'AIDER_BIN',
  versionArgs: ['--version'],
  // Aider routes via LiteLLM, so ids are spelled provider/model; other models can be typed in
  models: ['sonnet', 'gpt-4o', 'deepseek/deepseek-chat', 'gemini/gemini-2.0-flash'],
  docsUrl: 'https://aider.chat/docs/install.html',
  streamFormat: 'plain',
  promptViaStdin: false,
  // prompt goes through argv (--message); leave roughly 2.7KB of Windows cmdline headroom
  maxPromptArgBytes: 30_000,
  buildArgs({ model, prompt }) {
    const args = [
      '--yes-always',
      '--no-pretty',
      '--no-git',
      '--no-auto-commits',
      '--no-suggest-shell-commands',
      '--no-show-model-warnings',
    ];
    if (model && model !== 'default') args.push('--model', model);
    args.push('--message', prompt ?? '');
    return args;
  },
  createParser: createPlainTextParser,
};
