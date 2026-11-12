/**
 * Run manager — spawns a local agent CLI for one chat turn, parses its
 * stdout into agent events, keeps an ordered event log (for SSE replay via
 * ?after=<seq>) and fans events out to live subscribers.
 *
 * Simplified port of open-design's run state machine.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ChatRunError,
  ChatRunStatus,
  ChatRunStatusResponse,
  DaemonAgentPayload,
  RunArtifact,
  RemixclipChatSseEvent,
} from '@remixclip/contracts';
import { resolveAgentExecutable } from './executables.js';
import { classifyAgentFailure, errorCodeOf } from './errors.js';
import { recordQuotaExhausted, recordQuotaOk, recordUsage } from './quota-state.js';
import { agentCapabilities } from './detection.js';
import {
  diffWorkspaceSnapshots,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from '../run-artifacts.js';
import { attachAcpSession, type AcpSessionController } from '../agent-protocol/acp/index.js';
import {
  attachDshProfileSession,
  type DshProfileSessionController,
} from '../agent-protocol/dsh-profile/index.js';
import type { RuntimeAgentDef } from './types.js';

export interface StoredEvent {
  seq: number;
  event: RemixclipChatSseEvent['event'];
  data: unknown;
}

export interface RunRecord {
  id: string;
  agentId: string;
  conversationId: string;
  status: ChatRunStatus;
  createdAt: number;
  terminalAt?: number;
  exitCode?: number | null;
  error?: string;
  /** Accumulated assistant text (for persistence once the run ends). */
  assistantText: string;
  events: StoredEvent[];
  listeners: Set<(ev: StoredEvent) => void>;
  child?: ChildProcess;
  /** ACP session controller (on cancel, session/cancel + EOF first, then signals as fallback). */
  acpSession?: AcpSessionController;
  /** dsh profile session controller (on cancel, send the cancel command first). */
  dshSession?: DshProfileSessionController;
  /** Temp file used by promptViaFile adapters (cleaned up at terminal state). */
  promptFilePath?: string;
  /** The agent's working directory (scope of the snapshot diff). */
  cwd?: string | null;
  /** Workspace fingerprint baseline captured before spawn. */
  workspaceSnapshot?: WorkspaceSnapshot;
  /** Artifact list diffed after the run ends. */
  artifacts?: RunArtifact[];
  /** Agent-side durable session handle (captured at terminal time for resuming the same session). */
  durableSessionId?: string | null;
  /** Model this run was started with — part of the resume identity, persisted with the handle. */
  model?: string | null;
  /** The handle this run asked to resume (null = brand-new session), so a terminal failure can be
   *  attributed to the resume rather than to the task. */
  resumeSessionId?: string | null;
  /** Structured classification of the failure (kind / detail / expected reset time). */
  runError?: ChatRunError;
}

export interface CreateRunOptions {
  def: RuntimeAgentDef;
  prompt: string;
  conversationId: string;
  model?: string | null;
  cwd?: string | null;
  /** Env vars the user configured for this agent in settings (take precedence over inherited env). */
  configuredEnv?: Record<string, string>;
  /**
   * Resume the upstream session: ACP via session/load, claude via --resume;
   * null/undefined = new session.
   */
  resumeSessionId?: string | null;
}

const MAX_COMPLETED_RUNS = 200;
const RUN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export class RunManager {
  private runs = new Map<string, RunRecord>();
  private seqCounter = 0;

  listRuns(): ChatRunStatusResponse[] {
    return [...this.runs.values()].map((run) => this.toStatus(run));
  }

  getRun(runId: string): RunRecord | null {
    return this.runs.get(runId) ?? null;
  }

  toStatus(run: RunRecord): ChatRunStatusResponse {
    return {
      id: run.id,
      status: run.status,
      agentId: run.agentId,
      conversationId: run.conversationId,
      createdAt: run.createdAt,
      terminalAt: run.terminalAt,
      exitCode: run.exitCode,
      error: run.error,
      ...(run.runError ? { runError: run.runError } : {}),
      artifacts: run.artifacts,
      sessionId: run.durableSessionId ?? null,
    };
  }

  createRun(options: CreateRunOptions): RunRecord {
    const { def, prompt, conversationId, model, cwd, configuredEnv, resumeSessionId } = options;

    // def.env is the adapter's fixed env (e.g. reasonix's REASONIX_HOME);
    // user config (agentCliEnv) wins, consistent with open-design.
    const spawnEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...def.env,
      ...configuredEnv,
    };

    const binPath = resolveAgentExecutable(def, spawnEnv);
    if (!binPath) {
      throw new Error(`agent 不可用：未找到 ${def.bin} 可执行文件`);
    }

    const effectiveCwd = cwd ?? process.env.HOME ?? process.cwd();

    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      agentId: def.id,
      conversationId,
      status: 'queued',
      createdAt: Date.now(),
      assistantText: '',
      events: [],
      listeners: new Set(),
      cwd: effectiveCwd,
      durableSessionId: null,
      model: model ?? null,
      resumeSessionId: resumeSessionId ?? null,
    };
    this.runs.set(run.id, run);
    this.pruneCompletedRuns();

    // Artifact discovery (open-design run-artifact-fs): capture a workspace fingerprint
    // baseline before spawn, then diff at finishRun. best-effort — a failed scan never blocks the run.
    try {
      run.workspaceSnapshot = snapshotWorkspace(effectiveCwd);
    } catch {
      run.workspaceSnapshot = undefined;
    }

    // promptViaFile adapters (atomcode / grok-build) require the prompt in a temp file, whose
    // path buildArgs reads; the file is cleaned up at the run's terminal state.
    let promptFilePath: string | undefined;
    if (def.promptViaFile) {
      promptFilePath = path.join(tmpdir(), `remixclip-prompt-${randomUUID()}.txt`);
      writeFileSync(promptFilePath, prompt, 'utf8');
      run.promptFilePath = promptFilePath;
    }

    const args = def.buildArgs({
      model,
      resumeSessionId,
      prompt,
      promptFilePath,
      cwd: effectiveCwd,
      // Capabilities come from the `--help` probe in detection: def uses them to decide flags.
      capabilities: agentCapabilities(def.id),
    });
    const child = spawn(binPath, args, {
      cwd: effectiveCwd,
      env: spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    run.child = child;
    run.status = 'running';

    this.emit(run, 'start', {
      runId: run.id,
      agentId: def.id,
      bin: def.bin,
      model: model ?? null,
    });
    this.emitAgent(run, { type: 'status', label: 'agent 启动中', detail: binPath });

    const parseLine = def.createParser ? def.createParser() : null;
    let stdoutBuffer = '';
    let stderrTail = '';
    // Kept for failure classification: many CLIs print the real reason (quota / auth / 429) to
    // stdout as an error frame, while stderr stays empty. Without this tail the only thing left to
    // report was "exit code 1".
    let stdoutTail = '';
    let agentErrorText = '';
    const recordUsageEvent = (payload: DaemonAgentPayload) => {
      if (payload.type === 'usage') {
        recordUsage(def.id, {
          inputTokens: payload.usage?.inputTokens,
          outputTokens: payload.usage?.outputTokens,
          costUsd: payload.costUsd,
        });
      }
    };

    const emitParsed = (line: string) => {
      // For ndjson the durable session handle is extracted from the raw line (e.g. claude init frame)
      const sid = def.sessionIdFromLine?.(line);
      if (sid) run.durableSessionId = sid;
      // Error frames are the main stream's own words about why it died — keep the latest one.
      const frameError = frameErrorText(line);
      if (frameError) agentErrorText = frameError;
      for (const payload of parseLine?.(line) ?? []) {
        // Text from sub-agents (parent_tool_use_id != null) does not count toward the main answer
        if (payload.type === 'text_delta' && !payload.parentToolUseId) {
          run.assistantText += payload.delta;
        }
        if (payload.type === 'status' && payload.label === 'agent 错误' && payload.detail) {
          agentErrorText = payload.detail;
        }
        recordUsageEvent(payload);
        this.emitAgent(run, payload);
      }
    };

    let watchdog: ReturnType<typeof setInterval> | null = null;

    if (def.streamFormat === 'acp') {
      // ACP: bidirectional JSON-RPC, the prompt goes via session/prompt, nothing on raw stdin.
      // State machine mirrors open-design acp/session.ts:
      // - prompt response = this turn's terminal state (onTerminal('completed')); the process then
      //   gets 500ms to exit on its own, else SIGTERM (most ACP agents stay alive after stdin closes);
      // - fatal errors go through onTerminal('fatal'), the message is captured via send('error'),
      //   and finishRun emits the SSE error frame centrally;
      // - phase silence watchdog, tool flush, and auto-approval of permissions all live in the session.
      let acpErrorMessage: string | null = null;
      run.acpSession = attachAcpSession({
        child,
        prompt,
        cwd: effectiveCwd,
        model: model ?? null,
        resumeSessionId: resumeSessionId ?? null,
        completePromptOnTurnEnd: def.acp?.completePromptOnTurnEnd === true,
        envFormat: def.acp?.envFormat ?? 'array',
        send: (event, payload) => {
          if (event === 'error') {
            const obj = payload as { message?: unknown } | null;
            acpErrorMessage =
              obj && typeof obj.message === 'string' ? obj.message : 'ACP 会话失败';
            return;
          }
          const agentPayload = payload as DaemonAgentPayload;
          if (agentPayload.type === 'text_delta' && !agentPayload.parentToolUseId) {
            run.assistantText += agentPayload.delta;
          }
          recordUsageEvent(agentPayload);
          this.emitAgent(run, agentPayload);
        },
        onTerminal: (kind) => {
          if (watchdog) clearInterval(watchdog);
          if (kind === 'completed') {
            this.finishRun(run, 0, undefined, true);
          } else {
            const failure = classifyAgentFailure({
              text: acpErrorMessage ?? '',
              exitCode: 1,
              agentName: def.name,
              bin: def.bin,
            });
            this.finishRun(run, 1, failure.message, true, failure);
          }
          // Process-tree teardown ownership has been handed off: give the agent a chance to exit
          // on its own, SIGTERM on timeout
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGTERM');
            } catch {
              // Process already exited
            }
          }, 500);
        },
      });
    } else if (def.streamFormat === 'dsh-profile') {
      // DeepSeek Harness: ready → execute → frame stream → result terminal state
      let dshErrorMessage: string | null = null;
      run.dshSession = attachDshProfileSession({
        child,
        prompt,
        cwd: effectiveCwd,
        model: model ?? null,
        resumeSessionId: resumeSessionId ?? null,
        send: (event, payload) => {
          if (event === 'error') {
            const obj = payload as { message?: unknown } | null;
            dshErrorMessage =
              obj && typeof obj.message === 'string' ? obj.message : 'dsh profile 会话失败';
            return;
          }
          const agentPayload = payload as DaemonAgentPayload;
          if (agentPayload.type === 'text_delta') {
            run.assistantText += agentPayload.delta;
          }
          recordUsageEvent(agentPayload);
          this.emitAgent(run, agentPayload);
        },
        onTerminal: (kind) => {
          if (watchdog) clearInterval(watchdog);
          if (kind === 'completed') {
            this.finishRun(run, 0, undefined, true);
          } else {
            const failure = classifyAgentFailure({
              text: dshErrorMessage ?? '',
              exitCode: 1,
              agentName: def.name,
              bin: def.bin,
            });
            this.finishRun(run, 1, failure.message, true, failure);
          }
          setTimeout(() => {
            try {
              if (!child.killed) child.kill('SIGTERM');
            } catch {
              // Process already exited
            }
          }, 500);
        },
      });
    } else {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          emitParsed(line);
        }
      });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutTail = (stdoutTail + chunk).slice(-8000);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-8000);
    });

    child.on('error', (error) => {
      this.finishRun(run, null, `启动失败：${error.message}`);
    });

    // Idle watchdog — agents that go silent for too long are killed.
    let lastActivity = Date.now();
    const bumpActivity = () => {
      lastActivity = Date.now();
    };
    child.stdout.on('data', bumpActivity);
    child.stderr.on('data', bumpActivity);
    watchdog = setInterval(() => {
      if (run.status !== 'running') {
        if (watchdog) clearInterval(watchdog);
        return;
      }
      if (Date.now() - lastActivity > RUN_IDLE_TIMEOUT_MS) {
        if (watchdog) clearInterval(watchdog);
        this.cancelRun(run.id, 'agent 空闲超时');
      }
    }, 15_000);

    child.on('exit', (code) => {
      if (watchdog) clearInterval(watchdog);
      // Flush any trailing partial line.
      if (def.streamFormat !== 'acp' && def.streamFormat !== 'dsh-profile' && stdoutBuffer.trim()) {
        emitParsed(stdoutBuffer);
      }
      if (run.status === 'cancelled') {
        this.finishRun(run, code, run.error, true);
        return;
      }
      if (code === 0) {
        // Some CLIs exit 0 while the result frame says the turn failed (quota / auth). Only a
        // zero-output turn is treated as a failure: partial output still belongs to the user.
        const failure = agentErrorText.trim()
          ? classifyAgentFailure({
              text: [agentErrorText, stderrTail].join('\n'),
              exitCode: code,
              agentName: def.name,
              bin: def.bin,
            })
          : null;
        if (
          failure &&
          (failure.kind === 'quota' || failure.kind === 'rate_limit' || failure.kind === 'auth') &&
          !run.assistantText.trim()
        ) {
          this.finishRun(run, code, failure.message, true, failure);
          return;
        }
        this.finishRun(run, code, undefined, true);
      } else {
        const failure = classifyAgentFailure({
          text: [agentErrorText, stderrTail, stdoutTail].filter(Boolean).join('\n'),
          exitCode: code,
          agentName: def.name,
          bin: def.bin,
        });
        this.finishRun(run, code, failure.message, true, failure);
      }
    });

    // Prompt delivery: acp / dsh-profile go via protocol; file/argv styles carry it in buildArgs;
    // the rest write stdin (encoded per adapter requirements when needed).
    if (def.promptViaStdin && !def.promptViaFile) {
      const stdinPayload = def.encodeStdinPrompt ? def.encodeStdinPrompt(prompt) : prompt;
      child.stdin.write(stdinPayload);
      child.stdin.end();
    } else if (def.streamFormat !== 'acp' && def.streamFormat !== 'dsh-profile') {
      // argv / file-style agents don't read stdin; close it to give the CLI a clear EOF
      try {
        child.stdin.end();
      } catch {
        // Process may have exited already
      }
    }

    return run;
  }

  cancelRun(runId: string, reason?: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return false;
    run.status = 'cancelled';
    run.error = reason ?? '已取消';
    // ACP: protocol-level cancel first (session/cancel + stdin EOF), signal fallback after;
    // abort is idempotent. open-design follows the same order.
    if (run.acpSession) {
      try {
        run.acpSession.abort();
      } catch {
        // Transport already gone; fall through to the signal fallback below
      }
      setTimeout(() => {
        if (run.child && !run.child.killed) run.child.kill('SIGTERM');
      }, 500);
    } else if (run.dshSession) {
      try {
        run.dshSession.abort();
      } catch {
        // Transport already gone; fall through to the signal fallback below
      }
      setTimeout(() => {
        if (run.child && !run.child.killed) run.child.kill('SIGTERM');
      }, 500);
    } else {
      run.child?.kill('SIGTERM');
    }
    setTimeout(() => {
      if (run.child && !run.child.killed) run.child.kill('SIGKILL');
    }, 3_000);
    return true;
  }

  subscribe(
    runId: string,
    listener: (ev: StoredEvent) => void,
    afterSeq?: number,
  ): { unsubscribe: () => void; terminal: boolean } {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`run 不存在：${runId}`);

    // Replay backlog after the given seq (SSE Last-Event-ID reconnect).
    for (const ev of run.events) {
      if (afterSeq == null || ev.seq > afterSeq) listener(ev);
    }
    if (run.status !== 'running') {
      return { unsubscribe: () => undefined, terminal: true };
    }
    run.listeners.add(listener);
    return { unsubscribe: () => run.listeners.delete(listener), terminal: false };
  }

  private finishRun(
    run: RunRecord,
    code: number | null,
    error?: string,
    emitEnd = false,
    failure?: ChatRunError,
  ) {
    if (run.status !== 'running' && run.status !== 'cancelled') return;
    if (run.status === 'running') {
      run.status = error ? 'failed' : 'completed';
    }
    // Quota memory: an exhausted agent must not look healthy the next time settings is opened,
    // and a successful turn is the only proof that its quota is usable again.
    if (failure && (failure.kind === 'quota' || failure.kind === 'rate_limit')) {
      recordQuotaExhausted(run.agentId, {
        detail: failure.message,
        resetAt: failure.retryAfterAt ?? null,
      });
    } else if (!error) {
      recordQuotaOk(run.agentId);
    }
    // Capture the ACP session handle before the controller tears down (durable first, else ACP sessionId)
    if (run.acpSession) {
      run.durableSessionId =
        run.acpSession.getDurableSessionId() ?? run.acpSession.getSessionId();
    }
    // dsh profile: the durable session id comes from the session frame
    if (run.dshSession) {
      run.durableSessionId = run.dshSession.getDurableSessionId() ?? run.durableSessionId;
    }
    run.terminalAt = Date.now();
    run.exitCode = code;
    if (error) run.error = error;
    if (failure) run.runError = failure;
    // Artifact diff: done before the end frame is published (matching open-design's terminal
    // chokepoint timing), computed once per run (the cancelled path may re-enter finishRun).
    if (!run.artifacts && run.workspaceSnapshot && run.cwd) {
      try {
        run.artifacts = diffWorkspaceSnapshots(
          run.workspaceSnapshot,
          snapshotWorkspace(run.cwd),
        );
      } catch {
        // best-effort: a failed diff does not affect the run's terminal state
      }
      run.workspaceSnapshot = undefined;
    }
    if (error) {
      this.emit(run, 'error', {
        code: errorCodeOf(failure?.kind ?? 'agent'),
        message: error,
        ...(failure
          ? {
              kind: failure.kind,
              ...(failure.detail ? { detail: failure.detail } : {}),
              retryAfterAt: failure.retryAfterAt ?? null,
              exitCode: failure.exitCode ?? code,
            }
          : {}),
      });
    }
    if (emitEnd) {
      this.emit(run, 'end', {
        code,
        status: run.status,
        conversationId: run.conversationId,
        artifacts: run.artifacts ?? [],
        sessionId: run.durableSessionId ?? null,
      });
    }
    run.listeners.clear();
    run.child = undefined;
    run.acpSession = undefined;
    run.dshSession = undefined;
    if (run.promptFilePath) {
      try {
        rmSync(run.promptFilePath, { force: true });
      } catch {
        // Temp file cleanup failure does not affect the main flow
      }
      run.promptFilePath = undefined;
    }
  }

  private emitAgent(run: RunRecord, payload: DaemonAgentPayload) {
    this.emit(run, 'agent', payload);
  }

  private emit(run: RunRecord, event: RemixclipChatSseEvent['event'], data: unknown) {
    const stored: StoredEvent = { seq: ++this.seqCounter, event, data };
    run.events.push(stored);
    for (const listener of run.listeners) {
      try {
        listener(stored);
      } catch {
        // A listener error does not affect other subscribers
      }
    }
  }

  private pruneCompletedRuns() {
    const completed = [...this.runs.values()]
      .filter((run) => run.status !== 'running')
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const run of completed.slice(MAX_COMPLETED_RUNS)) {
      this.runs.delete(run.id);
    }
  }
}

/**
 * Read the failure out of one stdout line when the CLI reports it as a JSON frame instead of a
 * non-zero exit.
 *
 * Claude Code, for example, prints on quota exhaustion:
 *   {"type":"result","is_error":true,"result":"Claude AI usage limit reached|1730000000"}
 * Without reading it here, the only evidence left is the exit code, which is exactly the
 * "agent 退出码 1" the user could do nothing with.
 */
function frameErrorText(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  if (!trimmed.includes('"is_error"') && !trimmed.includes('"error"')) return null;
  try {
    const frame = JSON.parse(trimmed) as {
      type?: string;
      is_error?: boolean;
      result?: unknown;
      error?: unknown;
      message?: unknown;
      parent_tool_use_id?: unknown;
    };
    // A sub-agent's failure is its own: it must not turn the main turn into a failure.
    if (typeof frame.parent_tool_use_id === 'string' && frame.parent_tool_use_id) return null;
    if (frame.type === 'result' && frame.is_error === true) {
      return typeof frame.result === 'string' && frame.result.trim()
        ? frame.result
        : 'agent 返回错误';
    }
    if (frame.type === 'error') {
      if (typeof frame.error === 'string' && frame.error.trim()) return frame.error;
      if (typeof frame.message === 'string' && frame.message.trim()) return frame.message;
    }
  } catch {
    // Not a complete JSON frame (plain-text adapters) — ignore.
  }
  return null;
}
