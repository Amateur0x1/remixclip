/** @module agent-protocol/acp/session
 * Faithful port of the full state machine in open-design acp/session.ts (1556-line original),
 * with only the branches irrelevant to remixclip stripped out: AMR model billing, vela subagent
 * evidence, DSML artifact text suppression, Langfuse/PostHog telemetry redaction. The control flow
 * keeps every line:
 *
 *   initialize → session/new (or session/load to resume) → optional set_model
 *   → session/prompt → session/update event stream → prompt response terminal state
 *
 * Key invariants (all of them bought from open-design production incidents):
 * - per-stage silence watchdog (resetStageTimer, reset on any line received; <=0 disables);
 * - tool lifecycle state machine: partial frame accumulation, kind locks the name, path upgrade,
 *   sticky thinkOnly, terminal pairing (exactly one tool_use+tool_result pair), in-flight line
 *   throttling, host flush;
 * - terminal state: prompt response → flush tools → report usage → stdin.end(EOF)
 *   → onTerminal → SIGTERM if the process is still alive 500ms later;
 * - fail path is uniform: flush tools (isError) → onTerminal('fatal') → error frame → SIGTERM;
 * - abort: flush (isError) → session/cancel → stdin EOF;
 * - text: cumulative snapshot dedup (text.startsWith(emittedTextBuffer));
 * - JSON-RPC errors: recoverable set_model fallback, -32603 noise suppression, retryable inference;
 * - completePromptOnTurnEnd: some adapters use the turn_end update as the terminal signal (opt-in).
 */

import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { APP_NAME } from '@remixclip/brand';
import type { DaemonAgentPayload } from '@remixclip/contracts';
import {
  asObject,
  errorMessage,
  extractAcpStatusDetail,
  extractAcpUpdateText,
  type JsonObject,
} from './json.js';
import { createJsonLineStream } from './json-line-stream.js';
import {
  choosePermissionOutcome,
  formatUsage,
  inferRpcErrorRetryable,
  isJsonRpcId,
  rpcErrorData,
  rpcErrorMessage,
  rpcErrorRetryable,
  sendRpc,
  sendRpcResult,
  type JsonRpcId,
} from './rpc.js';
import {
  buildAcpSessionNewParams,
  buildPromptBlocks,
  type AcpMcpServerInput,
} from './session-params.js';
import {
  currentModelFromSessionResult,
  findModelConfigOption,
  modelSelectionErrorIsRecoverable,
} from './models.js';
import {
  acpToolCallId,
  acpToolInput,
  acpToolName,
  acpToolPathRanked,
  acpToolResultContent,
  isAcpRecognizedKind,
  isAcpTerminalFailureStatus,
  isAcpTerminalToolStatus,
  isAcpThinkOnlyTool,
  type AcpPathOptions,
} from './updates.js';

/** ACP protocol version (initialize handshake). */
const ACP_PROTOCOL_VERSION = 1;
/** Per-stage silence watchdog, 10 minutes by default (reset on any line received; <=0 disables). */
const DEFAULT_STAGE_TIMEOUT_MS = 10 * 60 * 1000;
/** Lower bound between two publications of the in-flight line for the same tool (the first is never delayed). */
const ACP_IN_FLIGHT_TOOL_MIN_INTERVAL_MS = 250;
/** Cap on the process output carried by the in-flight line. */
const ACP_IN_FLIGHT_TOOL_OUTPUT_LIMIT = 2_000;
/** Cap on the retained stderr tail (diagnosing early child exit). */
const ACP_STDERR_TAIL_LIMIT = 16_000;
const ACP_STDERR_DIAGNOSTIC_TAIL_LIMIT = 4_000;
/** These session/updates are metadata and do not go into the status line. */
const NON_DISPLAYABLE_ACP_SESSION_UPDATES = new Set([
  'usage_update',
  'session_info_update',
  'available_commands_update',
]);

export interface AttachAcpSessionOptions {
  child: ChildProcess;
  prompt: string;
  cwd?: string;
  model?: string | null;
  /** Attachment paths (resource_link blocks). */
  resourcePaths?: string[];
  /** stdio MCP servers injected into the session (e.g. remixclip's own research tools). */
  mcpServers?: AcpMcpServerInput[];
  envFormat?: 'array' | 'map';
  /** Resume an upstream session: the handshake goes through session/load instead of session/new. */
  resumeSessionId?: string | null;
  /** Some adapters use an explicit turn_end update as the terminal signal (rather than the prompt RPC returning). */
  completePromptOnTurnEnd?: boolean;
  /** Stage silence watchdog in milliseconds; <=0 disables. Defaults to REMIXCLIP_ACP_STAGE_TIMEOUT_MS. */
  stageTimeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  send: (event: 'agent' | 'error', payload: unknown) => void;
  onSessionInit?: () => void;
  /**
   * Once a clean or fatal verdict is reached, ownership of tearing down the process tree passes to the
   * caller; when not provided, the ACP bridge degrades to direct-child SIGTERM on its own.
   */
  onTerminal?: (kind: 'completed' | 'fatal') => void;
}

export interface AcpSessionController {
  /** Whether the session ended with a fatal protocol/transport error. */
  hasFatalError(): boolean;
  /** Upstream session handle for the next resume (null if the agent never reported one). */
  getDurableSessionId(): string | null;
  /** ACP session id for this run (returned by session/new|load; fallback handle when storing a resume). */
  getSessionId(): string | null;
  /** Prompt request ended cleanly, no fatal error, not aborted (even if the child was SIGTERM'd afterwards). */
  completedSuccessfully(): boolean;
  /** Idempotent abort: flush tools (isError) → session/cancel → stdin EOF. */
  abort(): void;
}

type AcpToolNameSource = 'kind' | 'other';

/** Accumulated state of a single toolCallId across partial frames. */
interface AcpToolRunState {
  name: string;
  nameSource: AcpToolNameSource;
  input: Record<string, unknown>;
  path: string | null;
  pathRank: number;
  resultContent: string;
  /** Sticky: once true, later pure status frames must not flip it back to false. */
  thinkOnly: boolean;
  firstSeenAt: number;
  emitted: boolean;
  /** The in-flight line has been shown on screen. */
  shown: boolean;
  lastShownSignature: string;
  lastShownAt: number;
}

export function attachAcpSession({
  child,
  prompt,
  cwd,
  model,
  resourcePaths = [],
  mcpServers,
  envFormat = 'array',
  resumeSessionId,
  completePromptOnTurnEnd = false,
  stageTimeoutMs,
  clientName = APP_NAME,
  clientVersion = 'runtime-adapter',
  send,
  onSessionInit,
  onTerminal,
}: AttachAcpSessionOptions): AcpSessionController {
  const runStartedAt = Date.now();
  const effectiveCwd = path.resolve(cwd || process.cwd());
  if (!child.stdin || !child.stdout) {
    throw new Error('ACP child process must expose stdin and stdout streams');
  }
  const stdin = child.stdin;
  const stdout = child.stdout;

  const effectiveStageTimeoutMs =
    stageTimeoutMs ??
    (() => {
      const raw = Number(process.env.REMIXCLIP_ACP_STAGE_TIMEOUT_MS);
      if (!Number.isFinite(raw)) return DEFAULT_STAGE_TIMEOUT_MS;
      return Math.min(24 * 60 * 60 * 1000, Math.max(0, Math.floor(raw)));
    })();

  let expectedId = 1;
  let nextId = 2;
  let promptRequestId: JsonRpcId | null = null;
  let setModelRequestId: JsonRpcId | null = null;
  let sessionId: string | null = null;
  // Upstream session handle for the next resume (distinct from the ACP wrapper id)
  let durableSessionId: string | null = null;
  let activeModel: string | null = null;
  let modelConfigId: string | null = null;
  let emittedThinkingStart = false;
  let emittedFirstTokenStatus = false;
  let emittedTextChunk = false;
  let emittedVisibleTextChunk = false;
  let emittedToolCall = false;
  let emittedConcreteToolEvent = false;
  let emittedTextBuffer = '';
  let acpStderrTail = '';
  let currentStage = 'initialize';
  let finished = false;
  let fatal = false;
  let aborted = false;
  let stageTimer: ReturnType<typeof setTimeout> | null = null;

  const toolRunState = new Map<string, AcpToolRunState>();

  const emitAgent = (payload: DaemonAgentPayload) => send('agent', payload);

  const buildToolUseInput = (st: AcpToolRunState): Record<string, unknown> => {
    const input = { ...st.input };
    if (st.path) input.file_path = st.path;
    else delete input.file_path;
    return input;
  };

  /**
   * Put still-running tool calls on screen, or refresh rows already on screen.
   *
   * ACP publishes calls as whole-frame state, so transcribing only terminal frames would make a call
   * invisible for its whole lifetime (open-design measured: 202 real calls hid 855 seconds of work
   * behind empty shells). Three invariants:
   *  1. It is not a terminal state — don't go through emitTerminalToolPair, don't flip emittedConcreteToolEvent;
   *  2. It will not become a second row — same id as the terminal tool_use, clients replace it in place;
   *  3. Rows that have been shown must be closed — thinkOnly filtering does not cover already-shown rows.
   * Throttling: the first publication is never delayed; later ones require a payload change and >= 250ms
   * since the last one.
   */
  const showInFlightTool = (toolCallId: string, st: AcpToolRunState): void => {
    if (st.emitted || st.thinkOnly) return;
    const output = st.resultContent ? st.resultContent.slice(0, ACP_IN_FLIGHT_TOOL_OUTPUT_LIMIT) : '';
    const payload: DaemonAgentPayload = {
      type: 'tool_in_flight',
      id: toolCallId,
      name: st.name,
      input: buildToolUseInput(st),
      startedAt: st.firstSeenAt,
      ...(output ? { output } : {}),
    };
    const signature = JSON.stringify([payload.type, st.name, buildToolUseInput(st), output]);
    const now = Date.now();
    if (st.shown) {
      if (signature === st.lastShownSignature) return;
      if (now - st.lastShownAt < ACP_IN_FLIGHT_TOOL_MIN_INTERVAL_MS) return;
    }
    st.shown = true;
    st.lastShownSignature = signature;
    st.lastShownAt = now;
    emitAgent(payload);
  };

  /**
   * Terminal pairing: exactly one tool_use + tool_result pair.
   * thinkOnly and never shown → don't transcribe; already shown must be closed (what appeared must be closed).
   * Once emitted is set, repeated terminal frames must not rebuild and resend.
   */
  const emitTerminalToolPair = (toolCallId: string, st: AcpToolRunState, isError: boolean) => {
    if (st.emitted) return;
    st.emitted = true;
    if (st.thinkOnly && !st.shown) return;
    emitAgent({
      type: 'tool_use',
      id: toolCallId,
      name: st.name,
      input: buildToolUseInput(st),
    });
    emitAgent({
      type: 'tool_result',
      toolUseId: toolCallId,
      content: st.resultContent || undefined,
      isError,
    });
    emittedConcreteToolEvent = true;
  };

  /**
   * Close tools that never received a terminal tool_call_update. Clean end uses isError=false (best-effort
   * close); the failure path uses isError=true (kept as an error result rather than dropped entirely).
   * The Map is not cleared after flush: late/racing terminal frames must not rebuild the same id as a new
   * open tool and emit another possibly contradictory tool_use/tool_result pair (st.emitted already
   * suppresses resending).
   */
  const flushOpenAcpTools = (isError = false) => {
    for (const [toolCallId, st] of toolRunState) {
      if (st.emitted) continue;
      emitTerminalToolPair(toolCallId, st, isError);
    }
  };

  const stageWatchdogDisabled = effectiveStageTimeoutMs <= 0;
  const resetStageTimer = (label: string) => {
    if (stageTimer) clearTimeout(stageTimer);
    if (stageWatchdogDisabled) return;
    stageTimer = setTimeout(() => {
      fail(`ACP ${label} 阶段静默超时（${effectiveStageTimeoutMs}ms）`, {
        retryable: true,
        details: {
          kind: 'acp_stage_timeout',
          action: 'retry',
          phase: label,
          timeout_ms: effectiveStageTimeoutMs,
        },
      });
    }, effectiveStageTimeoutMs);
  };

  const clearStageTimer = () => {
    if (stageTimer) clearTimeout(stageTimer);
    stageTimer = null;
  };

  /**
   * Terminate this run with one message. details is a shared slot: the daemon's own verdicts
   * (acp_stage_timeout / acp_child_exit) and the agent's error.data all land here, so daemon verdict
   * names must carry a mechanism namespace to avoid colliding with upstream payloads.
   */
  const fail = (
    message: string,
    options: { details?: unknown; retryable?: boolean } = {},
  ) => {
    if (finished) return;
    // Flush dangling tools as error results before the terminal state, so partial frames are not dropped from the timeline
    flushOpenAcpTools(true);
    finished = true;
    fatal = true;
    clearStageTimer();
    let terminalOwnedByCaller = false;
    try {
      onTerminal?.('fatal');
      terminalOwnedByCaller = onTerminal != null;
    } catch {
      // Fall back to the direct-child termination below
    }
    send(
      'error',
      options.details === undefined && options.retryable === undefined
        ? { message }
        : {
            message,
            error: {
              code: 'AGENT_EXECUTION_FAILED',
              message,
              retryable: options.retryable ?? false,
              ...(options.details === undefined ? {} : { details: options.details }),
            },
          },
    );
    if (!terminalOwnedByCaller && !child.killed) child.kill('SIGTERM');
  };

  const writeRpc = (id: JsonRpcId, method: string, params: unknown, timeoutLabel: string) => {
    currentStage = timeoutLabel;
    resetStageTimer(timeoutLabel);
    try {
      sendRpc(stdin, id, method, params);
    } catch (err) {
      fail(`stdin 写入失败：${errorMessage(err)}`);
    }
  };

  const emitVisibleTextDelta = (delta: string) => {
    if (!delta) return;
    emittedVisibleTextChunk = true;
    if (!emittedFirstTokenStatus) {
      emittedFirstTokenStatus = true;
      emitAgent({ type: 'status', label: 'streaming', detail: `${Date.now() - runStartedAt}ms` });
    }
    emitAgent({ type: 'text_delta', delta });
  };

  const sendPrompt = () => {
    promptRequestId = nextId;
    expectedId = promptRequestId;
    writeRpc(
      promptRequestId,
      'session/prompt',
      {
        sessionId,
        prompt: buildPromptBlocks(prompt, resourcePaths),
      },
      'session/prompt',
    );
    emitAgent({ type: 'status', label: '等待首个输出' });
    nextId += 1;
  };

  // Best-effort: report usage before the end, so failed runs also contribute token counts
  const emitUsageIfPresent = (usageSource?: unknown) => {
    const usage = formatUsage(usageSource);
    if (!usage) return;
    emitAgent({
      type: 'usage',
      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      },
      durationMs: Date.now() - runStartedAt,
    });
  };

  const finishCleanPrompt = (usageSource?: unknown) => {
    if (finished) return;
    // Set finished first: duplicate results and callback re-entry must not report clean completion twice
    finished = true;
    // Close all tools still open when the prompt completes, so every id has exactly one pair
    flushOpenAcpTools();
    emitUsageIfPresent(usageSource);
    clearStageTimer();
    stdin.end();
    let terminalOwnedByCaller = false;
    try {
      onTerminal?.('completed');
      terminalOwnedByCaller = onTerminal != null;
    } catch {
      // Fall back to the direct-child timer below
    }
    // Some ACP agents keep waiting for the next prompt after stdin closes;
    // one process per run, so kill it after a clean completion
    if (!terminalOwnedByCaller) {
      const cleanExitTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
      }, 500);
      child.once('close', () => clearTimeout(cleanExitTimer));
    }
  };

  const replyPermission = (raw: JsonObject) => {
    const params = asObject(raw.params);
    const optionId = choosePermissionOutcome(params?.options);
    if (!optionId || !isJsonRpcId(raw.id)) {
      fail(`未处理的 ACP 权限请求：${JSON.stringify(raw)}`);
      return;
    }
    resetStageTimer('session/request_permission');
    try {
      sendRpcResult(stdin, raw.id, {
        outcome: { outcome: 'selected', optionId },
      });
    } catch (err) {
      fail(`stdin 写入失败：${errorMessage(err)}`);
    }
  };

  const recoverFromModelSelectionError = () => {
    setModelRequestId = null;
    activeModel = activeModel || 'default';
    emitAgent({ type: 'status', label: `模型：${activeModel}` });
    sendPrompt();
  };

  const parser = createJsonLineStream((raw, rawLine) => {
    if (aborted || finished) return;
    resetStageTimer('response');
    const obj = asObject(raw);
    if (!obj) return;
    const error = asObject(obj.error);
    const params = asObject(obj.params);
    const result = asObject(obj.result);
    const rpcErr = rpcErrorMessage(obj);
    if (rpcErr) {
      // Late errors after the response is done (broken pipe, cleanup races) are safely ignored
      if (finished) return;
      // A -32603 error with an unexpected id is cleanup noise; a set_model failure is recoverable for
      // agents that have an implicit default (fall back to the default model and keep sending the prompt)
      if (
        obj.id === setModelRequestId &&
        modelSelectionErrorIsRecoverable(error?.code) &&
        promptRequestId === null
      ) {
        recoverFromModelSelectionError();
        return;
      }
      if (error?.code === -32603 && obj.id !== expectedId) {
        return;
      }
      const details = rpcErrorData(obj);
      const retryable = rpcErrorRetryable(details) ?? inferRpcErrorRetryable(rpcErr, details);
      fail(rpcErr, {
        details,
        ...(retryable === undefined ? {} : { retryable }),
      });
      return;
    }
    if (obj.method === 'session/request_permission') {
      replyPermission(obj);
      return;
    }
    const update = asObject(params?.update);
    if (obj.method === 'session/update' && update) {
      if (
        typeof update.sessionUpdate === 'string' &&
        NON_DISPLAYABLE_ACP_SESSION_UPDATES.has(update.sessionUpdate)
      ) {
        return;
      }
      if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'agent_thought_chunk') {
        const detail = extractAcpStatusDetail(update);
        emitAgent({
          type: 'status',
          label: String(update.sessionUpdate || 'session_update'),
          ...(detail ? { detail } : {}),
        });
      }
      if (
        completePromptOnTurnEnd &&
        promptRequestId !== null &&
        update.sessionUpdate === 'turn_end'
      ) {
        finishCleanPrompt(update.usage);
        return;
      }
      if (update.sessionUpdate === 'agent_thought_chunk') {
        const text = extractAcpUpdateText(update);
        if (text) {
          if (!emittedThinkingStart) {
            emittedThinkingStart = true;
          }
          emitAgent({ type: 'thinking_delta', delta: text });
        }
        return;
      }
      if (update.sessionUpdate === 'agent_message_chunk') {
        const text = extractAcpUpdateText(update);
        if (text) {
          // Some agents send a cumulative snapshot instead of a delta — dedup
          const isCumulativeSnapshot = text.startsWith(emittedTextBuffer);
          const delta = isCumulativeSnapshot ? text.slice(emittedTextBuffer.length) : text;
          if (delta.length > 0) {
            emittedTextChunk = true;
            emittedTextBuffer += delta;
            emitVisibleTextDelta(delta);
          }
        }
        return;
      }
      if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
        // This turn did real work (even if the model never spoke, that is not “no output”)
        emittedToolCall = true;
        const toolCallId = acpToolCallId(update);
        if (toolCallId) {
          const pathOptions: AcpPathOptions = { sessionCwd: effectiveCwd };
          const nextName = acpToolName(update);
          const nextInput = acpToolInput(update, pathOptions);
          const nextPath = acpToolPathRanked(update, pathOptions);
          const nextResult = acpToolResultContent(update);
          const nextThinkOnly = isAcpThinkOnlyTool(update);
          const kindRaw = typeof update.kind === 'string' ? update.kind.trim() : '';
          const nameFromKind = Boolean(kindRaw && isAcpRecognizedKind(kindRaw));
          let st = toolRunState.get(toolCallId);
          if (!st) {
            st = {
              name: nextName,
              nameSource: nameFromKind ? 'kind' : 'other',
              input: nextInput,
              path: nextPath?.path ?? null,
              pathRank: nextPath?.rank ?? 0,
              resultContent: nextResult,
              thinkOnly: nextThinkOnly,
              firstSeenAt: Date.now(),
              emitted: false,
              shown: false,
              lastShownSignature: '',
              lastShownAt: 0,
            };
            toolRunState.set(toolCallId, st);
          } else if (!st.emitted) {
            // kind locks the name: later title-only frames must not override it (after kind:read, title
            // “Update cache” must still stay Read)
            if (nameFromKind) {
              st.name = nextName;
              st.nameSource = 'kind';
            } else if (st.nameSource !== 'kind') {
              if (nextName !== 'Tool' || st.name === 'Tool') st.name = nextName;
            }
            // Shallow-merge rawInput, later keys win
            st.input = { ...st.input, ...nextInput };
            // Upgrade the path when a higher-priority source appears
            if (nextPath && (!st.path || nextPath.rank >= st.pathRank)) {
              st.path = nextPath.path;
              st.pathRank = nextPath.rank;
            }
            // Keep the last non-empty result (terminal frames may be status-only)
            if (nextResult) st.resultContent = nextResult;
            // thinkOnly is sticky: once classified, later frames must not flip it back
            if (nextThinkOnly) st.thinkOnly = true;
          }
          if (isAcpTerminalToolStatus(update)) {
            const failed = isAcpTerminalFailureStatus(update);
            emitTerminalToolPair(toolCallId, st, failed);
            // Keep the entry (emitted=true): repeated terminal frames must not resend
          } else {
            showInFlightTool(toolCallId, st);
          }
        }
        return;
      }
      return;
    }
    if (obj.id !== expectedId || !result) {
      return;
    }
    if (expectedId === 1) {
      expectedId = nextId;
      if (resumeSessionId) {
        // Resume the existing upstream session rather than creating a new one
        writeRpc(
          nextId,
          'session/load',
          { sessionId: resumeSessionId, cwd: effectiveCwd },
          'session/load',
        );
      } else {
        writeRpc(
          nextId,
          'session/new',
          buildAcpSessionNewParams(
            effectiveCwd,
            mcpServers ? { mcpServers, envFormat } : { envFormat },
          ),
          'session/new',
        );
      }
      nextId += 1;
      return;
    }
    if (expectedId === 2) {
      sessionId = typeof result.sessionId === 'string' ? result.sessionId : null;
      durableSessionId =
        typeof result.openCodeSessionId === 'string' ? result.openCodeSessionId : null;
      if (sessionId) onSessionInit?.();
      const modelConfig = findModelConfigOption(result.configOptions);
      modelConfigId = modelConfig?.configId ?? null;
      activeModel = currentModelFromSessionResult(result);
      if (sessionId && activeModel) {
        emitAgent({ type: 'status', label: `模型：${activeModel}` });
      }
      if (sessionId && model && model !== 'default') {
        setModelRequestId = nextId;
        expectedId = nextId;
        const setModelMethod = modelConfigId ? 'session/set_config_option' : 'session/set_model';
        const setModelParams = modelConfigId
          ? { sessionId, configId: modelConfigId, value: model }
          : { sessionId, modelId: model };
        writeRpc(nextId, setModelMethod, setModelParams, setModelMethod);
        nextId += 1;
        return;
      }
      if (!sessionId) {
        fail(`非法的 session/new 响应：${rawLine}`);
        return;
      }
      sendPrompt();
      return;
    }
    if (promptRequestId !== null && obj.id === promptRequestId) {
      // Flush open tools first: a successful session/prompt may omit terminal tool_call_updates;
      // closing them cleanly flips emittedConcreteToolEvent so the “no visible output” verdict stays correct
      flushOpenAcpTools();
      finishCleanPrompt(result.usage);
      return;
    }
    if (sessionId && model && model !== 'default' && obj.id === expectedId) {
      activeModel = currentModelFromSessionResult(result) ?? model;
      emitAgent({ type: 'status', label: `模型：${activeModel}` });
      sendPrompt();
    }
  });

  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => parser.feed(chunk));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    if (finished) return;
    acpStderrTail = `${acpStderrTail}${String(chunk)}`.slice(-ACP_STDERR_TAIL_LIMIT);
  });
  child.on('close', (code, signal) => {
    clearStageTimer();
    parser.flush();
    if (!finished && !aborted && !fatal) {
      const stderrTail = acpStderrTail
        .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/gu, '')
        .replace(/\r\n?/gu, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
        .trim()
        .slice(-ACP_STDERR_DIAGNOSTIC_TAIL_LIMIT);
      fail(`ACP 会话在完成前退出（code=${code ?? 'null'}，signal=${signal ?? 'none'}）`, {
        details: {
          kind: 'acp_child_exit',
          phase: currentStage,
          exit_code: code,
          signal,
          ...(stderrTail ? { stderr_tail: stderrTail } : {}),
        },
      });
    }
  });
  child.on('error', (err: Error) => fail(err.message));
  stdin.on('error', (err: Error) => fail(`stdin 错误：${err.message}`));

  writeRpc(
    1,
    'initialize',
    {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { terminal: false },
      clientInfo: { name: clientName, version: clientVersion },
    },
    'initialize',
  );

  /** Prompt request ended cleanly (no fatal protocol/transport error, not aborted). */
  const promptCompletedCleanly = () => finished && !fatal && !aborted;

  return {
    hasFatalError() {
      return fatal;
    },
    getDurableSessionId() {
      return durableSessionId;
    },
    getSessionId() {
      return sessionId;
    },
    completedSuccessfully() {
      return promptCompletedCleanly();
    },
    abort() {
      if (aborted || finished) return;
      // Flush dangling tools as error results before the final cancel
      flushOpenAcpTools(true);
      aborted = true;
      finished = true;
      clearStageTimer();
      if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
      // Only cancel an established session; there is no sessionId before session/new returns, but stdin must still close
      if (sessionId) {
        try {
          sendRpc(child.stdin, nextId, 'session/cancel', { sessionId });
          nextId += 1;
        } catch {
          // The caller's signal is the fallback once the transport is gone
        }
      }
      // Always close stdin to give the agent EOF so it tears down its own runtime,
      // rather than hanging until the caller's SIGTERM fallback fires
      try {
        child.stdin.end();
      } catch {
        // Best-effort; the caller still holds the SIGTERM/SIGKILL fallback
      }
    },
  };
}
