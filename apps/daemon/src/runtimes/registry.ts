import type { RuntimeAgentDef } from './types.js';
import { aiderAgentDef } from './defs/aider.js';
import { ampAgentDef } from './defs/amp.js';
import { amrAgentDef } from './defs/amr.js';
import { antigravityAgentDef } from './defs/antigravity.js';
import { atomcodeAgentDef } from './defs/atomcode.js';
import { byokOpenCodeAgentDef } from './defs/byok-opencode.js';
import { claudeAgentDef } from './defs/claude.js';
import { codebuddyAgentDef } from './defs/codebuddy.js';
import { codexAgentDef } from './defs/codex.js';
import { copilotAgentDef } from './defs/copilot.js';
import { cursorAgentDef } from './defs/cursor-agent.js';
import { deepseekAgentDef } from './defs/deepseek.js';
import { deepseekHarnessAgentDef } from './defs/deepseek-harness.js';
import { devinAgentDef } from './defs/devin.js';
import { geminiAgentDef } from './defs/gemini.js';
import { grokBuildAgentDef } from './defs/grok-build.js';
import { hermesAgentDef } from './defs/hermes.js';
import { kiloAgentDef } from './defs/kilo.js';
import { kimiAgentDef } from './defs/kimi.js';
import { kiroAgentDef } from './defs/kiro.js';
import { mcAgentDef } from './defs/mc.js';
import { mimoAgentDef } from './defs/mimo.js';
import { opencodeAgentDef } from './defs/opencode.js';
import { piAgentDef } from './defs/pi.js';
import { qoderAgentDef } from './defs/qoder.js';
import { qwenAgentDef } from './defs/qwen.js';
import { reasonixAgentDef } from './defs/reasonix.js';
import { traeCliAgentDef } from './defs/trae-cli.js';
import { vibeAgentDef } from './defs/vibe.js';

/**
 * All agents shipped with this project (aligned with open-design's SHIPPED_AGENT_DEFS).
 * The order is the display order in settings: internal/primary first, then grouped by protocol family.
 */
export const AGENT_DEFS: RuntimeAgentDef[] = [
  // Internal & primary coding CLIs
  mcAgentDef,
  claudeAgentDef,
  codebuddyAgentDef,
  codexAgentDef,
  copilotAgentDef,
  cursorAgentDef,
  // Other JSONL event-stream CLIs
  ampAgentDef,
  antigravityAgentDef,
  byokOpenCodeAgentDef,
  geminiAgentDef,
  mimoAgentDef,
  opencodeAgentDef,
  piAgentDef,
  qoderAgentDef,
  qwenAgentDef,
  // Plain-text / argv style
  aiderAgentDef,
  atomcodeAgentDef,
  deepseekAgentDef,
  grokBuildAgentDef,
  // ACP protocol family
  amrAgentDef,
  devinAgentDef,
  hermesAgentDef,
  kiloAgentDef,
  kimiAgentDef,
  kiroAgentDef,
  reasonixAgentDef,
  traeCliAgentDef,
  vibeAgentDef,
  // profile stdio protocol
  deepseekHarnessAgentDef,
];

export const DEFAULT_AGENT_ID = claudeAgentDef.id;

export function getAgentDef(id: string): RuntimeAgentDef | null {
  return AGENT_DEFS.find((def) => def.id === id) ?? null;
}
