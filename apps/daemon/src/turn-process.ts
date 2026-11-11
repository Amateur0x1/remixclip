/**
 * [INPUT]: a finished run's stored SSE events, in arrival order.
 * [OUTPUT]: the replayable turn process — text/thinking/tool items plus capped tool calls.
 * [POS]: daemon-side builder used when persisting an assistant message, so the collapsed operation
 *        chips survive a reload. The web has its own live reducer; the shapes must stay compatible.
 *
 * The block vocabulary (ordered text/thinking/tool items plus a tool-call table) follows Open
 * Design's turn-block model (Apache-2.0, see NOTICE); the rebuild itself is this project's own —
 * it reads stored SSE events rather than Open Design's persisted blocks.
 */

import type {
  ChatToolCall,
  ChatTurnItem,
  ChatTurnProcess,
  DaemonAgentPayload,
} from '@remixclip/contracts';

import type { StoredEvent } from './runtimes/runs.js';

/** Outputs are shown inside a collapsed chip, not exported: 4k is plenty and keeps the row small. */
const MAX_RESULT_CHARS = 4000;
const MAX_LIVE_TEXT_CHARS = 2000;
/** Hard ceiling for one message's process JSON; beyond it results are dropped oldest-first. */
const MAX_PAYLOAD_BYTES = 512 * 1024;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function emptyCall(payload: {
  id: string;
  name: string;
  input?: unknown;
  parentToolUseId?: string;
  subagentType?: string;
}): ChatToolCall {
  return {
    id: payload.id,
    name: payload.name,
    input: payload.input,
    parentToolUseId: payload.parentToolUseId,
    subagentType: payload.subagentType,
  };
}

/**
 * Rebuild the timeline the live view showed: text and thinking merged like the web reducer does,
 * one item per tool call in first-seen order, and results attached to their calls.
 */
export function turnProcessFromEvents(events: StoredEvent[]): ChatTurnProcess | undefined {
  const items: ChatTurnItem[] = [];
  const toolCalls: ChatToolCall[] = [];
  const byId = new Map<string, ChatToolCall>();

  const appendSegment = (kind: 'text' | 'thinking', delta: string) => {
    if (!delta) return;
    const last = items[items.length - 1];
    if (last && last.kind === kind) {
      items[items.length - 1] = { kind, text: last.text + delta };
    } else {
      items.push({ kind, text: delta });
    }
  };

  for (const stored of events) {
    if (stored.event !== 'agent') continue;
    const payload = stored.data as DaemonAgentPayload;

    switch (payload.type) {
      case 'text_delta':
        // Subagent speech belongs to its parent call, exactly as the live timeline nests it.
        if (payload.parentToolUseId) {
          const parent = byId.get(payload.parentToolUseId);
          if (parent) {
            parent.liveText = truncate(`${parent.liveText ?? ''}${payload.delta}`, MAX_LIVE_TEXT_CHARS);
          }
          break;
        }
        appendSegment('text', payload.delta);
        break;

      case 'thinking_delta':
        appendSegment('thinking', payload.delta);
        break;

      case 'tool_use': {
        // Snapshot-style tools rewrite the same id instead of adding a call.
        const existing = byId.get(payload.id);
        if (existing) {
          existing.name = payload.name;
          existing.input = payload.input;
          break;
        }
        const call = emptyCall(payload);
        byId.set(call.id, call);
        toolCalls.push(call);
        items.push({ kind: 'tool', id: call.id });
        break;
      }

      case 'tool_in_flight': {
        let call = byId.get(payload.id);
        if (!call) {
          call = emptyCall(payload);
          byId.set(call.id, call);
          toolCalls.push(call);
          items.push({ kind: 'tool', id: call.id });
        }
        call.name = payload.name;
        call.input = payload.input;
        if (payload.output) call.result = truncate(payload.output, MAX_RESULT_CHARS);
        break;
      }

      case 'tool_result': {
        const call = byId.get(payload.toolUseId);
        if (call) {
          call.result = truncate(payload.content ?? '', MAX_RESULT_CHARS);
          call.isError = payload.isError || undefined;
        }
        break;
      }

      default:
        // status / usage / raw carry no replayable structure.
        break;
    }
  }

  if (items.length === 0) return undefined;
  return trimToBudget({ items, toolCalls });
}

/**
 * Keep the whole process under one row's budget by dropping the oldest outputs first: the chips,
 * names and inputs (what the user scans) survive; only the least interesting logs are lost.
 */
function trimToBudget(process: ChatTurnProcess): ChatTurnProcess {
  let bytes = Buffer.byteLength(JSON.stringify(process), 'utf8');
  for (const call of process.toolCalls) {
    if (bytes <= MAX_PAYLOAD_BYTES) break;
    if (!call.result) continue;
    bytes -= Buffer.byteLength(call.result, 'utf8');
    call.result = undefined;
  }
  return process;
}
