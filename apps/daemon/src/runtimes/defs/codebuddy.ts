/**
 * Codebuddy Code (`codebuddy` / short alias `cbc`) -- a Claude Code-compatible CLI.
 *
 * The `-p --output-format stream-json` argument surface is a superset of Claude Code,
 * and the wire frame format matches too, so it reuses claude's parser and `--resume`
 * session continuation.
 *
 * Differences from claude: it adds the `--effort` reasoning tier and a multi-provider
 * model list; here only `--model` is exposed, the reasoning tier is not wired up yet.
 */

import type { RuntimeAgentDef } from '../types.js';
import { claudeAgentDef } from './claude.js';

export const codebuddyAgentDef: RuntimeAgentDef = {
  id: 'codebuddy',
  name: 'Codebuddy Code',
  bin: 'codebuddy',
  fallbackBins: ['cbc'],
  binEnvOverride: 'CODEBUDDY_BIN',
  versionArgs: ['--version'],
  docsUrl: 'https://www.codebuddy.cn/docs/workbuddy/Overview',
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, resumeSessionId }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model && model !== 'default') args.push('--model', model);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    // Unattended: skip all permission confirmations
    args.push('--permission-mode', 'bypassPermissions');
    return args;
  },
  sessionIdFromLine(line) {
    return claudeAgentDef.sessionIdFromLine!(line);
  },
  createParser() {
    return claudeAgentDef.createParser!();
  },
};
