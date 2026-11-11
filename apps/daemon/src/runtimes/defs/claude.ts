/**
 * Claude Code CLI agent definition.
 *
 * Launch: `claude -p --output-format stream-json --verbose` with the prompt
 * on stdin. Stdout is NDJSON: system / assistant / user / result events.
 *
 * Session resume: the init frame carries session_id; the daemon stores it per session
 * and rebuilds with `--resume <session_id>` on the next turn (multi-turn conversations
 * keep context instead of one-shot per turn).
 *
 * Sub-agent handling (ported from open-design claude-stream.ts):
 * - In-stream frames from Task sub-agents carry a top-level `parent_tool_use_id`; their
 *   text and tool calls are all tagged and forwarded, never mixed into the main answer;
 * - Errors in sub-agent frames must not bubble up as main-stream errors (error
 *   isolation, the same guard as #5488);
 * - If a tool_use has name === 'Task', extract input.subagent_type as the subagent type.
 */

import type { DaemonAgentPayload } from '@remixclip/contracts';
import type { RuntimeAgentDef } from '../types.js';

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function parentToolUseIdOf(msg: Record<string, unknown>): string | null {
  const value = msg.parent_tool_use_id;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function subagentTypeOf(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const value = (input as Record<string, unknown>).subagent_type;
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = content
      .map((block) =>
        block && typeof block === 'object'
          ? String((block as Record<string, unknown>).text ?? '')
          : '',
      )
      .filter(Boolean)
      .join('\n');
    return text || undefined;
  }
  return undefined;
}

export const claudeAgentDef: RuntimeAgentDef = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  binEnvOverride: 'CLAUDE_BIN',
  versionArgs: ['--version'],
  models: ['sonnet', 'opus', 'haiku'],
  docsUrl: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  // `-p --help` is the full switch set for non-interactive mode: capability bits are
  // decided by probing, not hard-coded per version.
  helpArgs: ['-p', '--help'],
  capabilityFlags: {
    '--include-partial-messages': 'partialMessages',
    '--resume': 'sessionResume',
    '--append-system-prompt': 'appendSystemPrompt',
    '--permission-mode': 'permissionMode',
    '--allowedTools': 'allowedTools',
  },
  // `claude auth status` prints JSON when logged in (loggedIn: true/false); when not
  // logged in it fails with 401 / `Please run /login`, so both shapes map to "not logged in"
  authProbe: {
    args: ['auth', 'status'],
    timeoutMs: 5000,
    unauthenticatedHints: [
      'not logged in',
      'no credentials',
      'logged out',
      'invalid bearer token',
      'run /login',
      'authentication_error',
    ],
    classify({ stdout }) {
      try {
        const parsed = JSON.parse(stdout) as { loggedIn?: unknown };
        if (typeof parsed.loggedIn === 'boolean') {
          return {
            status: parsed.loggedIn ? 'ok' : 'unauthenticated',
            detail: stdout.trim().slice(0, 300),
          };
        }
      } catch {
        // Older versions print plain text; fall back to keywords + exit code
      }
      return null;
    },
  },
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model, resumeSessionId }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (model) args.push('--model', model);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    return args;
  },
  sessionIdFromLine(line) {
    // The init frame carries this turn's (or the resumed) session id, the only
    // source of a persistent session handle
    if (!line.includes('"session_id"')) return null;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (
        msg.type === 'system' &&
        msg.subtype === 'init' &&
        typeof msg.session_id === 'string' &&
        msg.session_id.trim()
      ) {
        return msg.session_id;
      }
    } catch {
      // Not a JSON line, ignore
    }
    return null;
  },
  createParser() {
    // Main-stream and sub-agent text deltas are accounted separately (the text on
    // assistant events is cumulative)
    let mainTextLen = 0;
    const subTextLen = new Map<string, number>();
    const seenToolIds = new Set<string>();

    return (line: string): DaemonAgentPayload[] => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return line.trim() ? [{ type: 'raw', line }] : [];
      }

      const events: DaemonAgentPayload[] = [];
      const type = msg.type as string | undefined;
      const parentId = parentToolUseIdOf(msg);

      if (type === 'system' && msg.subtype === 'init') {
        events.push({ type: 'status', label: 'agent 已连接' });
        return events;
      }

      if (type === 'assistant') {
        const message = msg.message as { content?: ClaudeContentBlock[] } | undefined;
        const content = message?.content ?? [];

        // Diff the cumulative text per main stream / sub-agent
        const fullText = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('');
        if (parentId == null) {
          if (fullText.length > mainTextLen) {
            events.push({ type: 'text_delta', delta: fullText.slice(mainTextLen) });
            mainTextLen = fullText.length;
          }
        } else {
          const seen = subTextLen.get(parentId) ?? 0;
          if (fullText.length > seen) {
            events.push({
              type: 'text_delta',
              delta: fullText.slice(seen),
              parentToolUseId: parentId,
            });
            subTextLen.set(parentId, fullText.length);
          }
        }

        for (const block of content) {
          if (block.type === 'tool_use' && block.id && !seenToolIds.has(block.id)) {
            seenToolIds.add(block.id);
            const subagentType =
              block.name === 'Task' ? subagentTypeOf(block.input) : undefined;
            events.push({
              type: 'tool_use',
              id: block.id,
              name: block.name ?? 'tool',
              input: block.input,
              ...(parentId ? { parentToolUseId: parentId } : {}),
              ...(subagentType ? { subagentType } : {}),
            });
            if (subagentType) {
              events.push({
                type: 'status',
                label: `子代理启动 · ${subagentType}`,
              });
            }
          }
        }

        // Error isolation: errors in sub-agent frames don't bubble up as main-stream errors
        const error = typeof msg.error === 'string' ? msg.error.trim() : '';
        if (error && parentId == null) {
          const fallback = content
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
          events.push({ type: 'status', label: 'agent 错误', detail: fallback || error });
        }
        return events;
      }

      // The user frame carries tool_result blocks
      if (type === 'user') {
        const message = msg.message as { content?: ClaudeContentBlock[] } | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            events.push({
              type: 'tool_result',
              toolUseId: block.tool_use_id,
              content: toolResultText(block.content),
              isError: block.is_error === true,
              ...(parentId ? { parentToolUseId: parentId } : {}),
            });
          }
        }
        return events;
      }

      if (type === 'result') {
        const usage = msg.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        events.push({
          type: 'usage',
          usage: {
            inputTokens: usage?.input_tokens,
            outputTokens: usage?.output_tokens,
          },
          costUsd: msg.total_cost_usd as number | undefined,
          durationMs: msg.duration_ms as number | undefined,
        });
        return events;
      }

      return events;
    };
  },
};
