/** @module agent-protocol/dsh-profile
 *
 * DeepSeek Harness (`dsh --profile open-design --stdio`) profile stdio session bridge.
 *
 * Protocol (generation 1, ported from open-design agent-protocol/dsh-profile):
 *   host  → runtime: {"v":1,"type":"execute","request_id",cwd,prompt,
 *                     resume_session_id?,model?,reasoning_effort?,mcp_servers}
 *   runtime → host:  ready → session → (thinking|text|tool_call|tool_result|
 *                     usage)* → result / protocol_error
 * Cancel: host → runtime: {"v":1,"type":"cancel","request_id"}
 *
 * stdout is a pure protocol channel: an invalid frame is a fatal error; no strict per-field validation
 * here, only the two invariants are guaranteed — “recognized frames become agent events, the terminal
 * state always converges”.
 */

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DaemonAgentPayload } from '@remixclip/contracts';

const PROTOCOL_VERSION = 1;
/** profile name: dsh only recognizes the open-design profile bundle. */
const PROFILE_NAME = 'open-design';
const MAX_FRAME_BYTES = 1024 * 1024;

export interface AttachDshProfileSessionOptions {
  child: ChildProcess;
  prompt: string;
  cwd: string;
  model?: string | null;
  resumeSessionId?: string | null;
  send: (event: 'agent' | 'error', payload: unknown) => void;
  onTerminal: (kind: 'completed' | 'fatal') => void;
}

export interface DshProfileSessionController {
  /** Durable session id for the next resume. */
  getDurableSessionId(): string | null;
  /** Whether this run completed cleanly (result.status === 'completed' with no fatal error). */
  completedSuccessfully(): boolean;
  /** Idempotent abort: cancel command + stdin EOF. */
  abort(): void;
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Split the model param as `provider/id`; 'default'/empty → unspecified. */
function modelSelection(
  value: string | null | undefined,
): { provider: string; id: string } | null {
  const normalized = value?.trim();
  if (!normalized || normalized === 'default') return null;
  const separator = normalized.indexOf('/');
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error('DeepSeek Harness 模型须为 provider/id 形式（如 deepseek/deepseek-chat）');
  }
  return {
    provider: normalized.slice(0, separator),
    id: normalized.slice(separator + 1),
  };
}

function toolInput(argumentsJson: string): Record<string, unknown> {
  try {
    const value = JSON.parse(argumentsJson) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // Keep the raw arguments; don't escalate a parse failure into a protocol error
  }
  return { raw: argumentsJson };
}

export function attachDshProfileSession({
  child,
  prompt,
  cwd,
  model,
  resumeSessionId,
  send,
  onTerminal,
}: AttachDshProfileSessionOptions): DshProfileSessionController {
  if (!child.stdin || !child.stdout) {
    throw new Error('dsh profile 子进程必须暴露 stdin/stdout');
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const requestId = randomUUID();
  const selectedModel = modelSelection(model);

  let buffer = '';
  let ready = false;
  let sessionId: string | null = null;
  let terminalStatus: 'completed' | 'cancelled' | 'failed' | null = null;
  let finished = false;
  let fatal = false;
  let aborted = false;
  let thinkingStarted = false;

  const emit = (payload: DaemonAgentPayload) => send('agent', payload);

  const writeCommand = (command: JsonObject): void => {
    if (stdin.destroyed || !stdin.writable) return;
    stdin.write(`${JSON.stringify(command)}\n`);
  };

  const finish = (kind: 'completed' | 'fatal', message?: string): void => {
    if (finished) return;
    finished = true;
    if (message) send('error', { message });
    try {
      stdin.end();
    } catch {
      // Process has already exited
    }
    onTerminal(kind);
  };

  const fail = (message: string): void => {
    if (finished) return;
    fatal = true;
    terminalStatus = 'failed';
    finish('fatal', message);
  };

  const sendExecute = (): void => {
    writeCommand({
      v: PROTOCOL_VERSION,
      type: 'execute',
      request_id: requestId,
      cwd,
      prompt,
      ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      mcp_servers: [],
    });
  };

  const handleFrame = (frame: JsonObject): void => {
    if (finished) return;
    const type = typeof frame.type === 'string' ? frame.type : '';
    const frameRequestId = typeof frame.request_id === 'string' ? frame.request_id : null;

    if (!ready) {
      if (type !== 'ready') {
        fail('DeepSeek Harness profile 未以 ready 帧开始');
        return;
      }
      ready = true;
      emit({ type: 'status', label: 'agent 已连接', detail: PROFILE_NAME });
      if (aborted) {
        terminalStatus = 'cancelled';
        finish('completed');
        return;
      }
      sendExecute();
      return;
    }

    if (type === 'ready' || type === 'probe') {
      fail('DeepSeek Harness profile 发出了意外的身份帧');
      return;
    }
    if (frameRequestId && frameRequestId !== requestId) return;

    switch (type) {
      case 'session': {
        if (sessionId) {
          fail('DeepSeek Harness profile 重复发出 session 帧');
          return;
        }
        sessionId = typeof frame.session_id === 'string' ? frame.session_id : null;
        if (resumeSessionId && (frame.resumed !== true || sessionId !== resumeSessionId)) {
          fail('DeepSeek Harness profile 恢复了不同的会话');
          return;
        }
        emit({ type: 'status', label: 'agent 运行中', ...(sessionId ? { detail: sessionId } : {}) });
        return;
      }
      case 'thinking': {
        const content = typeof frame.content === 'string' ? frame.content : '';
        if (!thinkingStarted) thinkingStarted = true;
        if (content) emit({ type: 'thinking_delta', delta: content });
        return;
      }
      case 'text': {
        const content = typeof frame.content === 'string' ? frame.content : '';
        if (content) emit({ type: 'text_delta', delta: content });
        return;
      }
      case 'tool_call': {
        const id = typeof frame.call_id === 'string' ? frame.call_id : '';
        const name = typeof frame.name === 'string' ? frame.name : 'tool';
        if (!id) return;
        emit({
          type: 'tool_use',
          id,
          name,
          input: toolInput(typeof frame.arguments === 'string' ? frame.arguments : '{}'),
        });
        return;
      }
      case 'tool_result': {
        const id = typeof frame.call_id === 'string' ? frame.call_id : '';
        if (!id) return;
        emit({
          type: 'tool_result',
          toolUseId: id,
          content: typeof frame.output === 'string' ? frame.output : undefined,
          isError: frame.is_error === true,
        });
        return;
      }
      case 'usage': {
        const input = typeof frame.input_tokens === 'number' ? frame.input_tokens : undefined;
        const output = typeof frame.output_tokens === 'number' ? frame.output_tokens : undefined;
        emit({ type: 'usage', usage: { inputTokens: input, outputTokens: output } });
        return;
      }
      case 'protocol_error': {
        fail(
          typeof frame.message === 'string'
            ? `DeepSeek Harness 协议错误：${frame.message}`
            : 'DeepSeek Harness 协议错误',
        );
        return;
      }
      case 'result': {
        const status = typeof frame.status === 'string' ? frame.status : 'failed';
        terminalStatus =
          status === 'completed' || status === 'cancelled' || status === 'failed'
            ? status
            : 'failed';
        if (terminalStatus === 'failed') {
          const error = isRecord(frame.error) ? frame.error : null;
          fail(
            error && typeof error.message === 'string'
              ? error.message
              : 'DeepSeek Harness 本轮执行失败',
          );
          return;
        }
        if (terminalStatus === 'cancelled' && !aborted) {
          fail('DeepSeek Harness 取消了非 daemon 发起的运行');
          return;
        }
        finish('completed');
        return;
      }
      default:
        // Unknown frames (later protocol generations) are ignored, keeping forward compatibility
        return;
    }
  };

  const handleLine = (line: string): void => {
    const candidate = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!candidate.trim()) return;
    if (Buffer.byteLength(candidate, 'utf8') > MAX_FRAME_BYTES) {
      fail('DeepSeek Harness profile 单帧过大');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      fail('DeepSeek Harness profile 输出了非法 JSON 帧');
      return;
    }
    if (!isRecord(parsed)) {
      fail('DeepSeek Harness profile 帧不是对象');
      return;
    }
    handleFrame(parsed);
  };

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => {
    if (finished) return;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      if (finished) return;
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      fail('DeepSeek Harness profile 单帧过大');
    }
  });

  child.on('close', () => {
    if (finished) return;
    const residual = buffer.trim();
    buffer = '';
    if (residual) handleLine(residual);
    if (!finished) fail('DeepSeek Harness profile 在终态 result 之前退出');
  });
  child.on('error', (err: Error) => fail(err.message));
  stdin.on('error', (err: Error) => fail(`stdin 错误：${err.message}`));

  return {
    getDurableSessionId() {
      return sessionId;
    },
    completedSuccessfully() {
      return terminalStatus === 'completed' && !fatal;
    },
    abort() {
      if (finished || aborted) return;
      aborted = true;
      writeCommand({ v: PROTOCOL_VERSION, type: 'cancel', request_id: requestId });
      try {
        stdin.end();
      } catch {
        // The caller still has the signal fallback
      }
    },
  };
}
