/**
 * BYOK OpenCode -- run OpenCode with the user's own configured provider/model.
 *
 * Differences from the opencode definition:
 *   1. Model ids pass through verbatim (in `provider/model` form), fitting any
 *      OpenCode provider;
 *   2. Explicit `--dir <cwd>`: OpenCode hoists nested dirs up to the nearest git root,
 *      and when the managed workdir is not a git repo it writes artifacts to the wrong
 *      place;
 *   3. `--dangerously-skip-permissions`: unattended runs must skip permission prompts.
 */

import type { RuntimeAgentDef } from '../types.js';
import { createOpenCodeParser, openCodeSessionIdFromLine } from './opencode.js';

export const byokOpenCodeAgentDef: RuntimeAgentDef = {
  id: 'byok-opencode',
  name: 'BYOK OpenCode',
  bin: 'opencode-cli',
  fallbackBins: ['opencode'],
  binEnvOverride: 'OPENCODE_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://opencode.ai/docs/providers',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, cwd }) {
    const args = ['run', '--format', 'json'];
    if (cwd) args.push('--dir', cwd);
    args.push('--dangerously-skip-permissions');
    if (model && model !== 'default') args.push('-m', model);
    return args;
  },
  sessionIdFromLine: openCodeSessionIdFromLine,
  createParser: createOpenCodeParser,
};
