/**
 * Gemini CLI -- `gemini --yolo`; the prompt goes through stdin, plain-text output.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createPlainTextParser } from './plain.js';

export const geminiAgentDef: RuntimeAgentDef = {
  id: 'gemini',
  name: 'Gemini CLI',
  bin: 'gemini',
  models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  docsUrl: 'https://github.com/google-gemini/gemini-cli',
  binEnvOverride: 'GEMINI_BIN',
  versionArgs: ['--version'],
  // Capability bits: newer versions replaced --yolo with --approval-mode.
  helpArgs: ['--help'],
  capabilityFlags: {
    '--approval-mode': 'approvalMode',
    '--yolo': 'yoloFlag',
    '--output-format': 'outputFormat',
  },
  streamFormat: 'plain',
  promptViaStdin: true,
  buildArgs({ model, capabilities }) {
    // Switch to the new form only when probing finds no --yolo but --approval-mode
    // present; when not probed (null) keep the original argv unchanged.
    const args = capabilities && !capabilities.has('yoloFlag') && capabilities.has('approvalMode')
      ? ['--approval-mode', 'yolo']
      : ['--yolo'];
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createPlainTextParser,
};
