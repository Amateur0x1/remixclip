/**
 * Trae CLI — ACP mode (`traecli acp serve --yolo`).
 */

import type { RuntimeAgentDef } from '../types.js';

export const traeCliAgentDef: RuntimeAgentDef = {
  id: 'trae-cli',
  name: 'Trae CLI',
  bin: 'traecli',
  binEnvOverride: 'TRAE_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://www.trae.ai/cli',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp', 'serve', '--yolo'];
  },
  acp: { envFormat: 'array' },
};
