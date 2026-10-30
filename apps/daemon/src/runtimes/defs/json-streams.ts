/**
 * NDJSON output parsers for various agents (ported from open-design).
 *
 * Each factory returns `(line) => DaemonAgentPayload[]`, structurally identical to the parsers in
 * the claude/codex/opencode defs, so runs.ts can feed lines uniformly.
 *
 *   copilot      GitHub Copilot CLI (`--output-format json`)
 *   qoder        Qoder CLI (`--output-format stream-json`)
 *   cursor-agent Cursor Agent (`--print --output-format stream-json`)
 *   antigravity  Antigravity `agy` (`--output-format stream-json`)
 */

import type { DaemonAgentPayload } from '@remixclip/contracts';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonObject(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** GitHub Copilot CLI — `tool.execution_*` / `assistant.*` events. */
export function createCopilotParser(): (line: string) => DaemonAgentPayload[] {
  return (line: string): DaemonAgentPayload[] => {
    const obj = parseJsonObject(line);
    if (!obj) return line.trim() ? [{ type: 'raw', line }] : [];
    const type = typeof obj.type === 'string' ? obj.type : '';
    const data = isRecord(obj.data) ? obj.data : {};
    const events: DaemonAgentPayload[] = [];

    switch (type) {
      case 'session.tools_updated':
        if (typeof data.model === 'string' && data.model) {
          events.push({ type: 'status', label: '模型', detail: data.model });
        }
        return events;

      case 'assistant.turn_start':
        events.push({ type: 'status', label: 'agent 运行中' });
        return events;

      case 'assistant.reasoning_delta':
        if (typeof data.deltaContent === 'string' && data.deltaContent) {
          events.push({ type: 'thinking_delta', delta: data.deltaContent });
        }
        return events;

      case 'assistant.message_delta':
        if (typeof data.deltaContent === 'string' && data.deltaContent) {
          events.push({ type: 'text_delta', delta: data.deltaContent });
        }
        return events;

      case 'tool.execution_start': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        if (!id) return events;
        events.push({
          type: 'tool_use',
          id,
          name: typeof data.toolName === 'string' ? data.toolName : 'tool',
          input: data.arguments ?? undefined,
        });
        return events;
      }

      case 'tool.execution_complete': {
        const id = typeof data.toolCallId === 'string' ? data.toolCallId : '';
        if (!id) return events;
        events.push({
          type: 'tool_result',
          toolUseId: id,
          content: stringifyContent(data.result),
          isError: data.success === false,
        });
        return events;
      }

      case 'result': {
        const usage = isRecord(obj.usage) ? obj.usage : undefined;
        events.push({
          type: 'usage',
          usage: {
            inputTokens: typeof usage?.inputTokens === 'number'
              ? usage.inputTokens
              : typeof usage?.input_tokens === 'number'
                ? usage.input_tokens
                : undefined,
            outputTokens: typeof usage?.outputTokens === 'number'
              ? usage.outputTokens
              : typeof usage?.output_tokens === 'number'
                ? usage.output_tokens
                : undefined,
          },
          durationMs: typeof obj.durationMs === 'number' ? obj.durationMs : undefined,
        });
        return events;
      }

      default:
        return events;
    }
  };
}

/** Qoder CLI — `system` / `assistant` / `result` envelope records. */
export function createQoderParser(): (line: string) => DaemonAgentPayload[] {
  return (line: string): DaemonAgentPayload[] => {
    const obj = parseJsonObject(line);
    if (!obj) return line.trim() ? [{ type: 'raw', line }] : [];
    const type = typeof obj.type === 'string' ? obj.type : '';
    const events: DaemonAgentPayload[] = [];

    if (type === 'system' && obj.subtype === 'init') {
      events.push({
        type: 'status',
        label: 'agent 已连接',
        ...(typeof obj.model === 'string' && obj.model ? { detail: obj.model } : {}),
      });
      return events;
    }

    if (type === 'assistant' && isRecord(obj.message)) {
      const content = Array.isArray(obj.message.content) ? obj.message.content : [];
      let emittedText = false;
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          emittedText = true;
          events.push({ type: 'text_delta', delta: block.text });
          continue;
        }
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
          events.push({ type: 'thinking_delta', delta: block.thinking });
        }
      }
      if (!emittedText && typeof obj.message.content === 'string' && obj.message.content) {
        events.push({ type: 'text_delta', delta: obj.message.content });
      }
      return events;
    }

    if (type === 'result') {
      const usage = isRecord(obj.usage) ? obj.usage : undefined;
      events.push({
        type: 'usage',
        usage: {
          inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
          outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
        },
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      });
      if (obj.is_error === true) {
        const message = typeof obj.error === 'string'
          ? obj.error
          : isRecord(obj.error) && typeof obj.error.message === 'string'
            ? obj.error.message
            : typeof obj.message === 'string'
              ? obj.message
              : 'Qoder 运行失败';
        events.push({ type: 'status', label: 'agent 错误', detail: message });
      }
      return events;
    }

    return line.trim() ? [{ type: 'raw', line }] : [];
  };
}

function extractCursorText(message: unknown): string {
  const content = isRecord(message) ? message.content : undefined;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('');
}

/** Cursor Agent — incremental chunks plus a full final replay need prefix reconciliation. */
export function createCursorAgentParser(): (line: string) => DaemonAgentPayload[] {
  let textSoFar = '';
  let turnStart = 0;

  const reconcile = (text: string): string => {
    const emittedTurn = textSoFar.slice(turnStart);
    let suffix = '';
    if (text && text !== emittedTurn && text.startsWith(emittedTurn)) {
      suffix = text.slice(emittedTurn.length);
      textSoFar += suffix;
    }
    turnStart = textSoFar.length;
    return suffix;
  };

  return (line: string): DaemonAgentPayload[] => {
    const obj = parseJsonObject(line);
    if (!obj) return line.trim() ? [{ type: 'raw', line }] : [];
    const type = typeof obj.type === 'string' ? obj.type : '';
    const events: DaemonAgentPayload[] = [];

    if (type === 'system' && obj.subtype === 'init') {
      events.push({
        type: 'status',
        label: 'agent 已连接',
        ...(typeof obj.model === 'string' && obj.model ? { detail: obj.model } : {}),
      });
      return events;
    }

    if (type === 'assistant' && obj.message) {
      const text = extractCursorText(obj.message);
      if (typeof obj.model_call_id === 'string') {
        const suffix = reconcile(text);
        if (suffix) events.push({ type: 'text_delta', delta: suffix });
        return events;
      }
      if (!text) return events;
      if (typeof obj.timestamp_ms === 'number') {
        // Live incremental: forward each chunk verbatim (legitimate duplicate chunks must not be deduped)
        textSoFar += text;
        events.push({ type: 'text_delta', delta: text });
        return events;
      }
      const suffix = reconcile(text);
      if (suffix) events.push({ type: 'text_delta', delta: suffix });
      return events;
    }

    if (type === 'result' && isRecord(obj.usage)) {
      events.push({
        type: 'usage',
        usage: {
          inputTokens: typeof obj.usage.inputTokens === 'number' ? obj.usage.inputTokens : undefined,
          outputTokens: typeof obj.usage.outputTokens === 'number' ? obj.usage.outputTokens : undefined,
        },
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
      });
      return events;
    }

    return events;
  };
}

/** Antigravity `agy --output-format stream-json` — event-discriminated frames. */
export function createAntigravityParser(): (line: string) => DaemonAgentPayload[] {
  const seenToolUses = new Set<string>();
  let textEmitted = false;

  return (line: string): DaemonAgentPayload[] => {
    const obj = parseJsonObject(line);
    if (!obj) return line.trim() ? [{ type: 'raw', line }] : [];
    const event = typeof obj.event === 'string' ? obj.event : '';
    const events: DaemonAgentPayload[] = [];

    if (event === 'init') {
      events.push({
        type: 'status',
        label: 'agent 已连接',
        ...(typeof obj.conversation_id === 'string' ? { detail: obj.conversation_id } : {}),
      });
      return events;
    }

    if (event === 'step_update') {
      const step = isRecord(obj.step_update) ? obj.step_update : null;
      if (!step) return events;
      if (step.step_type === 'agent_response') {
        if (typeof step.text_delta === 'string' && step.text_delta) {
          textEmitted = true;
          events.push({ type: 'text_delta', delta: step.text_delta });
        }
        return events;
      }
      if (step.step_type === 'tool') {
        const toolInfo = isRecord(step.tool_info) ? step.tool_info : {};
        const name = typeof toolInfo.name === 'string'
          ? toolInfo.name
          : typeof step.tool_name === 'string'
            ? step.tool_name
            : 'tool';
        const id = `${String(step.conversation_id ?? obj.conversation_id ?? '')}:${String(step.step_index ?? '')}`;
        if (!seenToolUses.has(id)) {
          seenToolUses.add(id);
          events.push({ type: 'tool_use', id, name, input: toolInfo.parameters ?? undefined });
        }
        if (step.state === 'DONE' || step.state === 'ERROR') {
          events.push({
            type: 'tool_result',
            toolUseId: id,
            content: stringifyContent(toolInfo.output ?? ''),
            isError: step.state === 'ERROR',
          });
        }
        return events;
      }
      return events;
    }

    if (event === 'result') {
      const result = isRecord(obj.result) ? obj.result : null;
      if (!result) return events;
      if (result.status !== 'SUCCESS') {
        events.push({
          type: 'status',
          label: 'agent 错误',
          detail: typeof result.error === 'string' && result.error
            ? result.error
            : `Antigravity 运行状态 ${String(result.status ?? 'unknown')}`,
        });
        return events;
      }
      if (!textEmitted && typeof result.response === 'string' && result.response) {
        textEmitted = true;
        events.push({ type: 'text_delta', delta: result.response });
      }
      const usage = isRecord(result.usage) ? result.usage : undefined;
      events.push({
        type: 'usage',
        usage: {
          inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
          outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
        },
        durationMs: typeof result.duration_seconds === 'number'
          ? Math.round(result.duration_seconds * 1000)
          : undefined,
      });
      return events;
    }

    return events;
  };
}

/** The Antigravity init frame carries conversation_id, usable as a resume handle. */
export function antigravitySessionIdFromLine(line: string): string | null {
  if (!line.includes('conversation_id')) return null;
  const obj = parseJsonObject(line);
  if (!obj || obj.event !== 'init') return null;
  const id = obj.conversation_id;
  return typeof id === 'string' && id.trim() ? id : null;
}
