/**
 * Cursor Agent -- `cursor-agent --print --output-format stream-json`.
 *
 * The prompt goes through stdin (Cursor doesn't recognize `-` as a stdin sentinel, so
 * no fake prompt argument can be appended). `--stream-partial-output` enables
 * chunk-by-chunk incremental text; `--force` is headless auto-approve. `--trust` only
 * exists in newer versions, so it isn't passed here (older versions exit on unknown option).
 */

import type { RuntimeAgentDef } from '../types.js';
import { createCursorAgentParser } from './json-streams.js';

export const cursorAgentDef: RuntimeAgentDef = {
  id: 'cursor-agent',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  binEnvOverride: 'CURSOR_AGENT_BIN',
  versionArgs: ['--version'],
  models: ['auto', 'sonnet-4', 'sonnet-4-thinking', 'gpt-5'],
  docsUrl: 'https://cursor.com/docs/cli/overview',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, cwd }) {
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--force',
    ];
    if (cwd) args.push('--workspace', cwd);
    if (model && model !== 'default') args.push('--model', model);
    return args;
  },
  createParser: createCursorAgentParser,
};
