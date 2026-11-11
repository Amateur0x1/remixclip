/**
 * Qwen Code — a Gemini-CLI fork. `qwen --yolo`, prompt over stdin, plain-text output.
 * See open-design defs/qwen.ts.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const qwenAgentDef: RuntimeAgentDef = {
  id: 'qwen',
  name: 'Qwen Code',
  bin: 'qwen',
  models: ['qwen3-coder-plus', 'qwen3-coder-flash'],
  docsUrl: 'https://github.com/QwenLM/qwen-code',
  binEnvOverride: 'QWEN_BIN',
  versionArgs: ['--version'],
  streamFormat: 'plain',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['--yolo'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createPlainTextParser,
};
