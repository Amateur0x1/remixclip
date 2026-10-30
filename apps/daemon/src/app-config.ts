/**
 * App config — persisted user preferences (a slimmed-down open-design /api/app-config).
 *
 * Stored in <dataDir>/app-config.json. Core fields:
 * - agentId      currently selected agent
 * - agentModels  model chosen per agent
 * - agentCliEnv  custom launch env vars per agent (e.g. ANTHROPIC_BASE_URL /
 *                ANTHROPIC_AUTH_TOKEN), injected at spawn and taking precedence over inherited env
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

/**
 * Env var allowlist configurable per agent (ported from open-design app-config.ts and
 * extended with common provider keys). Keys outside the allowlist are dropped on save to
 * prevent arbitrary env var injection.
 */
export const AGENT_CLI_ENV_KEYS: Readonly<Record<string, readonly string[]>> = {
  claude: [
    'CLAUDE_BIN',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ],
  // mc (CatPaw Code) proxies claude, so it reuses claude's auth/base-url vars + MC_BIN override
  mc: [
    'MC_BIN',
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
  ],
  codex: ['CODEX_BIN', 'CODEX_HOME', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY'],
  hermes: ['HERMES_BIN', 'XAI_API_KEY', 'OPENAI_API_KEY'],
  kimi: ['KIMI_BIN', 'MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  opencode: ['OPENCODE_BIN', 'OPENCODE_CONFIG', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  qwen: ['QWEN_BIN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY'],
  gemini: ['GEMINI_BIN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL'],
  pi: ['PI_BIN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  // ── Added to align with open-design ──
  aider: [
    'AIDER_BIN',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
    'GEMINI_API_KEY',
    'AIDER_MODEL',
  ],
  amp: ['AMP_BIN', 'AMP_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  amr: [
    'VELA_BIN',
    'VELA_RUNTIME_KEY',
    'VELA_LINK_URL',
    'VELA_OPENCODE_BIN',
    'VELA_DEFAULT_MODEL',
  ],
  antigravity: ['AGY_BIN', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT'],
  atomcode: [
    'ATOMCODE_BIN',
    'ATOMCODE_HOME',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'DEEPSEEK_API_KEY',
  ],
  'byok-opencode': [
    'OPENCODE_BIN',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_CONTENT',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
    'GEMINI_API_KEY',
    'OPENROUTER_API_KEY',
  ],
  codebuddy: [
    'CODEBUDDY_BIN',
    'CODEBUDDY_API_KEY',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ],
  copilot: ['COPILOT_BIN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  'cursor-agent': ['CURSOR_AGENT_BIN', 'CURSOR_API_KEY'],
  deepseek: ['DEEPSEEK_BIN', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
  'deepseek-harness': ['DSH_BIN', 'DSH_HOME', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY'],
  devin: ['DEVIN_BIN', 'DEVIN_API_KEY'],
  'grok-build': ['GROK_BIN', 'GROK_HOME', 'XAI_API_KEY'],
  kilo: ['KILO_BIN', 'KILO_API_KEY'],
  kiro: ['KIRO_BIN', 'KIRO_API_KEY'],
  mimo: ['MIMO_BIN', 'MIMOCODE_CONFIG_CONTENT', 'MIMO_API_KEY', 'OPENAI_API_KEY'],
  qoder: ['QODER_BIN', 'QODER_PERSONAL_ACCESS_TOKEN'],
  reasonix: ['REASONIX_BIN', 'REASONIX_HOME', 'DEEPSEEK_API_KEY'],
  'trae-cli': ['TRAE_BIN', 'TRAE_API_KEY'],
  vibe: ['VIBE_BIN', 'MISTRAL_API_KEY'],
};

export interface AppConfigPrefs {
  agentId?: string;
  agentModels?: Record<string, string>;
  agentCliEnv?: AgentCliEnvPrefs;
}

let configPath: string | null = null;
let cached: AppConfigPrefs | null = null;

export function initAppConfig(dataDir: string): void {
  configPath = path.join(dataDir, 'app-config.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
}

export function readAppConfig(): AppConfigPrefs {
  if (cached) return cached;
  if (configPath && existsSync(configPath)) {
    try {
      cached = JSON.parse(readFileSync(configPath, 'utf8')) as AppConfigPrefs;
      return cached;
    } catch {
      // Corrupted config is treated as empty config
    }
  }
  cached = {};
  return cached;
}

export function writeAppConfig(patch: Partial<AppConfigPrefs>): AppConfigPrefs {
  const current = readAppConfig();
  const next: AppConfigPrefs = {
    ...current,
    ...patch,
    agentModels: { ...current.agentModels, ...patch.agentModels },
    agentCliEnv: mergeCliEnv(current.agentCliEnv, patch.agentCliEnv),
  };
  cached = next;
  if (configPath) {
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8');
  }
  return next;
}

function mergeCliEnv(
  current?: AgentCliEnvPrefs,
  patch?: AgentCliEnvPrefs,
): AgentCliEnvPrefs | undefined {
  if (!current && !patch) return undefined;
  const merged: AgentCliEnvPrefs = { ...current };
  for (const [agentId, env] of Object.entries(patch ?? {})) {
    const allowlist = AGENT_CLI_ENV_KEYS[agentId];
    merged[agentId] = { ...merged[agentId] };
    for (const [key, value] of Object.entries(env)) {
      // Allowlist filter (always allow *_BIN overrides)
      if (allowlist && !allowlist.includes(key) && !key.endsWith('_BIN')) continue;
      merged[agentId][key] = value;
    }
    // An empty string means delete the key
    for (const [key, value] of Object.entries(merged[agentId])) {
      if (value === '') delete merged[agentId][key];
    }
    if (Object.keys(merged[agentId]).length === 0) delete merged[agentId];
  }
  return merged;
}

/** Get an agent's configured env vars (expands the ~ prefix). */
export function agentCliEnvForAgent(
  prefs: AppConfigPrefs,
  agentId: string,
): Record<string, string> {
  const env = prefs.agentCliEnv?.[agentId] ?? {};
  const home = process.env.HOME ?? '';
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    expanded[key] = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  }
  return expanded;
}
