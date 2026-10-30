/**
 * Codex CLI agent definition.
 *
 * Launch: `codex exec --json -` with the prompt on stdin. Stdout is NDJSON
 * with thread/turn/item events; `item.completed` carries finished items.
 */

import type { DaemonAgentPayload } from '@remixclip/contracts';
import { agentSupports, type RuntimeAgentDef } from '../types.js';

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
}

export const codexAgentDef: RuntimeAgentDef = {
  id: 'codex',
  name: 'Codex',
  bin: 'codex',
  models: ['gpt-5-codex', 'gpt-5'],
  docsUrl: 'https://developers.openai.com/codex/',
  binEnvOverride: 'CODEX_BIN',
  // ChatGPT.app doesn't put codex on PATH, but the app bundle ships a directly
  // spawnable CLI and native binary. Fall back to them when PATH lookup fails, so
  // we don't show "Codex not detected" when ChatGPT is installed.
  bundleBins: [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '~/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '~/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ],
  // `codex debug models` prints { models: [{ slug, display_name, ... }] }, which varies by
  // client version.
  listModels: {
    args: ['debug', 'models'],
    timeoutMs: 5000,
    parse(stdout) {
      try {
        const parsed = JSON.parse(stdout) as { models?: { slug?: unknown }[] };
        const slugs = (parsed.models ?? [])
          .map((model) => (typeof model.slug === 'string' ? model.slug.trim() : ''))
          .filter(Boolean);
        if (slugs.length > 0) return slugs;
      } catch {
        // Older versions have no debug models; fall back to the static list.
      }
      return [];
    },
  },
  versionArgs: ['--version'],
  // Capability bits: only switches present in help count as supported (older versions
  // lack --skip-git-repo-check).
  helpArgs: ['--help'],
  capabilityFlags: {
    '--skip-git-repo-check': 'skipGitRepoCheck',
    '--json': 'jsonEvents',
  },
  authProbe: {
    args: ['login', 'status'],
    timeoutMs: 5000,
    unauthenticatedHints: ['not logged in', 'logged out', 'no credentials'],
  },
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, capabilities }) {
    const args = ['exec', '--json'];
    // Don't pass it when probing finds the switch missing: otherwise the whole run
    // fails to start on an unknown argument.
    if (agentSupports(capabilities, 'skipGitRepoCheck')) args.push('--skip-git-repo-check');
    if (model) args.push('-m', model);
    args.push('-'); // prompt via stdin
    return args;
  },
  createParser() {
    const seenItemIds = new Set<string>();

    return (line: string): DaemonAgentPayload[] => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return line.trim() ? [{ type: 'raw', line }] : [];
      }

      const events: DaemonAgentPayload[] = [];
      const type = msg.type as string | undefined;

      if (type === 'turn.started') {
        events.push({ type: 'status', label: 'agent 运行中' });
        return events;
      }

      if (type === 'item.completed') {
        const item = msg.item as CodexItem | undefined;
        if (!item || (item.id && seenItemIds.has(item.id))) return events;
        if (item.id) seenItemIds.add(item.id);

        if (item.type === 'agent_message' && item.text) {
          events.push({ type: 'text_delta', delta: item.text });
        } else if (item.type === 'command_execution') {
          const id = item.id ?? `cmd-${seenItemIds.size}`;
          events.push({
            type: 'tool_use',
            id,
            name: 'shell',
            input: { command: item.command },
          });
          events.push({
            type: 'tool_result',
            toolUseId: id,
            content: item.aggregated_output,
            isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
          });
        }
        return events;
      }

      if (type === 'turn.completed') {
        const usage = msg.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        if (usage) {
          events.push({
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
            },
          });
        }
        return events;
      }

      return events;
    };
  },
};
