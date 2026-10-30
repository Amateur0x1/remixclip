/**
 * CatPaw Code — agent def for the company's internally wrapped Claude Code CLI (`mc --code`).
 *
 * `mc` is an internal multi-purpose CLI; `mc --code <args...>` passes the following args and
 * stdin/stdout through verbatim to the local claude (measured: `mc --code --version` →
 * `1.0.98 (Claude Code)`), so this def only does the following on top of the claude def:
 *   1. swap bin to `mc` and prepend a `--code` switch to the base argv;
 *   2. probe the version via `mc --code --version` (that is the claude version; bare
 *      `mc --version` returns the CLI's own version);
 *   3. always pass `--model` (the internal gateway routes by model; running bare hits
 *      "no routing policy matched") and expose the internally routable model list;
 *   4. auto-inject `--dangerously-skip-permissions` at startup (skip tool permission prompts,
 *      so the agent is not interrupted by interactions in the unattended conversation loop);
 *   5. use `--settings` to pin `ANTHROPIC_BASE_URL` to the internal gateway — the `env` of the
 *      user's `~/.claude/settings.json` overrides the gateway address injected by mc (pointing
 *      it at Vercel AI Gateway yields a straight 401), while `--settings` has higher priority
 *      and corrects it reliably.
 *
 * The output protocol (stream-json NDJSON), session resume (session_id in the init frame), Task
 * subagent tagging etc. are all the same as claude, so we reuse claudeAgentDef's parser directly.
 */

import type { RuntimeAgentDef } from '../types.js';
import { claudeAgentDef } from './claude.js';

/** The switch arg for `mc` to proxy Claude Code. */
const CODE_FLAG = '--code';

/** Auto-injected at startup: skip tool permission prompts (passed through to claude via `mc --code`). */
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * Company-internal gateway base URL (mc injects the same address itself). We pin it once more
 * via `--settings` because the user's `~/.claude/settings.json` `env.ANTHROPIC_BASE_URL` overrides
 * the env var injected by mc; `--settings` outranks user settings and keeps them from routing
 * requests to an external gateway (e.g. Vercel).
 */
const GATEWAY_BASE_URL = 'https://mcli.sankuai.com';

/** Models currently routable on the internal gateway (dropdown candidates in the UI; custom input is also allowed). */
const MODELS = [
  'kimi-k3',
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'gpt-6-sol',
  'gpt-6-luna',
];

/** Default model: mc --code must carry --model, so fall back to this one when none is given. */
const DEFAULT_MODEL = 'kimi-k3';

export const mcAgentDef: RuntimeAgentDef = {
  id: 'mc',
  name: 'CatPaw Code (mc --code)',
  bin: 'mc',
  binEnvOverride: 'MC_BIN',
  versionArgs: [CODE_FLAG, '--version'],
  models: MODELS,
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs(options) {
    // Critical: mc --code without --model is rejected by the internal gateway as
    // "no routing policy matched", so always inject model (explicit choice wins; empty
    // string / undefined both fall back to the default model).
    const model = options.model?.trim() || DEFAULT_MODEL;
    return [
      CODE_FLAG,
      SKIP_PERMISSIONS_FLAG,
      ...claudeAgentDef.buildArgs({ ...options, model }),
      // Critical: pin the internal gateway base URL so the user's ~/.claude/settings.json env cannot override it.
      '--settings',
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: GATEWAY_BASE_URL } }),
    ];
  },
  sessionIdFromLine(line) {
    return claudeAgentDef.sessionIdFromLine!(line);
  },
  createParser() {
    return claudeAgentDef.createParser!();
  },
};
