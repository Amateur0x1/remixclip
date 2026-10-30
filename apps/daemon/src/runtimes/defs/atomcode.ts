/**
 * AtomCode -- an open-source Rust terminal coding agent.
 *
 * Headless mode `--prompt-file <PATH>` runs a single turn and emits the plain-text
 * answer directly; `-y` auto-approves tool calls. The prompt goes through a temp
 * file, sidestepping argv length limits.
 *
 * Auth is held by AtomCode itself (`atomcode login` or ~/.atomcode/config.toml);
 * the daemon injects no credentials. Any OpenAI-compatible provider works.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const atomcodeAgentDef: RuntimeAgentDef = {
  id: 'atomcode',
  name: 'AtomCode CLI',
  bin: 'atomcode',
  binEnvOverride: 'ATOMCODE_BIN',
  versionArgs: ['--version'],
  models: [
    'claude-sonnet-4-6',
    'claude-sonnet-4-5',
    'gpt-5.2',
    'glm-5.2',
    'deepseek-v4',
  ],
  docsUrl: 'https://atomcode.atomgit.com/docs/en/index.html',
  streamFormat: 'plain',
  promptViaStdin: false,
  promptViaFile: true,
  buildArgs({ model, promptFilePath }) {
    if (!promptFilePath) throw new Error('atomcode 需要 prompt 临时文件');
    const args = ['--prompt-file', promptFilePath, '-y'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createPlainTextParser,
};
