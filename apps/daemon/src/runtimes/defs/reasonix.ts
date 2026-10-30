/**
 * DeepSeek Reasonix — ACP mode (`reasonix acp`).
 *
 * Reasonix's ACP implementation keeps the system prompt separate from user messages: without a
 * system append it tends to treat the request as a pure coding task and ignores the working-
 * directory conventions in the context. We inject a lightweight note here to keep its behavior
 * consistent with this project's working-directory model.
 *
 * The ACP implementation of reasonix ≥1.0 (a Go rewrite) requires MCP env in the standard map
 * shape, hence acp.envFormat = 'map'.
 */

import os from 'node:os';
import path from 'node:path';
import type { RuntimeAgentDef } from '../types.js';

const SYSTEM_APPEND = `# RemixClip integration

You are running inside RemixClip, a local-first product workbench.

1. Treat the user message as the complete task brief; follow its instructions in order.
2. Write every produced file inside the current working directory given in the brief.
3. Reply with the relative paths of the files you wrote (do not paste whole files back).
4. Do not add git commits or other repository side effects.`;

/** Reasonix home directory (respects an already-set REASONIX_HOME). */
function reasonixHome(): string {
  if (process.env.REASONIX_HOME) return process.env.REASONIX_HOME;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'reasonix');
  }
  return path.join(os.homedir(), '.reasonix');
}

export const reasonixAgentDef: RuntimeAgentDef = {
  id: 'reasonix',
  name: 'DeepSeek Reasonix',
  bin: 'reasonix',
  fallbackBins: ['dsnix'],
  binEnvOverride: 'REASONIX_BIN',
  versionArgs: ['--version'],
  models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  docsUrl: 'https://esengine.github.io/DeepSeek-Reasonix/',
  streamFormat: 'acp',
  promptViaStdin: false,
  buildArgs() {
    return ['acp'];
  },
  env: {
    REASONIX_ACP_SYSTEM_APPEND: SYSTEM_APPEND,
    REASONIX_HOME: reasonixHome(),
  },
  acp: { envFormat: 'map' },
};
