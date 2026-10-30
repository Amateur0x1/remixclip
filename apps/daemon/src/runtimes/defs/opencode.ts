/**
 * OpenCode — `opencode run --format json`, prompt over stdin, NDJSON event stream.
 * Event format ported from open-design json-event-stream.ts:
 *   step_start / text(part.text) / tool_use(part.tool, part.callID) / step_finish
 */

import type { DaemonAgentPayload } from '@remixclip/contracts';
import type { RuntimeAgentDef } from '../types.js';

/** JSON event parser shared by the OpenCode family (opencode / byok-opencode / mimo). */
export function createOpenCodeParser(): (line: string) => DaemonAgentPayload[] {
  const seenToolUses = new Set<string>();
  const seenToolResults = new Set<string>();

  return (line: string): DaemonAgentPayload[] => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return line.trim() ? [{ type: 'raw', line }] : [];
    }

    const events: DaemonAgentPayload[] = [];
    const part = (msg.part ?? {}) as Record<string, unknown>;
    const type = msg.type as string | undefined;

    if (type === 'step_start') {
      events.push({ type: 'status', label: 'agent 运行中' });
      return events;
    }

    if (type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      events.push({ type: 'text_delta', delta: part.text });
      return events;
    }

    if (type === 'tool_use' && typeof part.tool === 'string') {
      const callId = String(part.callID ?? `call-${seenToolUses.size}`);
      if (!seenToolUses.has(callId)) {
        seenToolUses.add(callId);
        const state = part.state as Record<string, unknown> | undefined;
        events.push({
          type: 'tool_use',
          id: callId,
          name: part.tool,
          input: state?.input,
        });
      }
      const state = part.state as
        | { status?: string; output?: string; error?: string }
        | undefined;
      if (
        state &&
        (state.status === 'completed' || state.status === 'error' || state.status === 'failed') &&
        !seenToolResults.has(callId)
      ) {
        seenToolResults.add(callId);
        events.push({
          type: 'tool_result',
          toolUseId: callId,
          content: state.output ?? state.error,
          isError: state.status === 'error' || state.status === 'failed',
        });
      }
      return events;
    }

    if (type === 'step_finish') {
      const tokens = part.tokens as
        | { input?: number; output?: number }
        | undefined;
      if (tokens) {
        events.push({
          type: 'usage',
          usage: { inputTokens: tokens.input, outputTokens: tokens.output },
          costUsd: typeof part.cost === 'number' ? part.cost : undefined,
        });
      }
      return events;
    }

    // Structured error frames (provider auth/network failures) must be visible too, otherwise the run "succeeds silently"
    if (type === 'error') {
      events.push({
        type: 'status',
        label: 'agent 错误',
        detail: typeof msg.message === 'string' ? msg.message : 'OpenCode 运行失败',
      });
      return events;
    }

    return events;
  };
}

/** OpenCode session handle: every event carries sessionID, the first being step_start. */
export function openCodeSessionIdFromLine(line: string): string | null {
  if (!line.includes('"sessionID"')) return null;
  try {
    const msg = JSON.parse(line) as Record<string, unknown>;
    const id = msg.sessionID;
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    return null;
  }
}

export const opencodeAgentDef: RuntimeAgentDef = {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode-cli',
  docsUrl: 'https://opencode.ai/docs',
  fallbackBins: ['opencode'],
  binEnvOverride: 'OPENCODE_BIN',
  versionArgs: ['--version'],
  streamFormat: 'ndjson',
  promptViaStdin: true,
  buildArgs({ model }) {
    const args = ['run', '--format', 'json'];
    if (model && model !== 'default') args.push('-m', model);
    return args;
  },
  sessionIdFromLine: openCodeSessionIdFromLine,
  createParser: createOpenCodeParser,
};
