'use client';

/**
 * [INPUT]: daemon SSE/cancel APIs and the conversation currently being viewed.
 * [OUTPUT]: Independent background runs, ordered live turns, terminal messages and reconnect controls.
 * [POS]: Workspace run lifecycle; navigation never cancels a daemon run.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunArtifact } from '@remixclip/contracts';
import { cancelRun, streamRunEvents, type RunStreamHandlers } from '@/providers/daemon';
import { EMPTY_TURN, appendDelta, mergeMessages, type LiveTurn, type ToolCall, type UiMessage } from '@/components/chat/chat-types';
import { MANUAL_RECONNECT_FEEDBACK_MS, nextChatReconnectView, reconnectViewForConversation, type ChatReconnectSignal, type ChatReconnectView } from '@/runtime/chat/reconnect-state';
import { t } from '@/i18n';

type ActiveRun = { runId: string; startedAt: number };
type StreamContext = { conversationId: string; startedAt: number; controller: AbortController };

export function useWorkspaceRuns(currentConvId: string | null, onSettled: () => Promise<void>) {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [turn, setTurn] = useState<LiveTurn>(EMPTY_TURN);
  const [runningByConv, setRunningByConv] = useState<Record<string, ActiveRun>>({});
  const runningRef = useRef(runningByConv);
  runningRef.current = runningByConv;
  const viewConvRef = useRef<string | null>(currentConvId);
  const liveTurnsRef = useRef(new Map<string, LiveTurn>());
  const streamsRef = useRef(new Map<string, StreamContext>());
  const finalizedRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const [reconnect, setReconnect] = useState<ChatReconnectView | null>(null);
  const reconnectRef = useRef<ChatReconnectView | null>(null);
  const reconnectByConvRef = useRef(new Map<string, ChatReconnectView>());
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dispatchReconnect = useCallback((signal: ChatReconnectSignal) => {
    const conversationId = 'conversationId' in signal ? signal.conversationId
      : 'runId' in signal && signal.runId
        ? [...reconnectByConvRef.current.entries()].find(([, value]) => value.runId === signal.runId)?.[0] ?? viewConvRef.current
        : viewConvRef.current;
    if (!conversationId) return;
    const previous = reconnectByConvRef.current.get(conversationId) ?? null;
    const next = nextChatReconnectView(previous, signal);
    if (next) reconnectByConvRef.current.set(conversationId, next);
    else reconnectByConvRef.current.delete(conversationId);
    if (viewConvRef.current === conversationId) {
      reconnectRef.current = next;
      setReconnect(next);
    }
  }, []);
  const updateRunTurn = useCallback((runId: string, update: (turn: LiveTurn) => LiveTurn) => {
    const value = update(liveTurnsRef.current.get(runId) ?? EMPTY_TURN);
    liveTurnsRef.current.set(runId, value);
    if (runningRef.current[viewConvRef.current ?? '']?.runId === runId) setTurn(value);
  }, []);

  const finalizeRun = useCallback((runId: string, conversationId: string, startedAt: number, artifacts?: RunArtifact[]) => {
    if (finalizedRef.current.has(runId)) return;
    finalizedRef.current.add(runId);
    const final = liveTurnsRef.current.get(runId) ?? EMPTY_TURN;
    const content = final.items.filter((item) => item.kind === 'text').map((item) => item.text).join('').trim();
    const parts = [content, final.error ? t('chat.errorPrefix', { message: final.error }) : '', final.stopped ? t('chat.stopped') : ''].filter(Boolean);
    if (viewConvRef.current === conversationId) {
      if (parts.length || final.toolCalls.length || artifacts?.length) {
        const message: UiMessage = {
          id: `assistant-${runId}`, conversationId, role: 'assistant', content: parts.join('\n\n') || t('message.noTextOutput'),
          createdAt: Date.now(), runId, toolCalls: final.toolCalls, turnItems: final.items.length ? final.items : undefined,
          stopped: final.stopped || undefined, error: final.error, elapsedMs: Date.now() - startedAt, artifacts,
        };
        setMessages((previous) => mergeMessages(previous, [message]));
      }
      setTurn(EMPTY_TURN);
    }
    liveTurnsRef.current.delete(runId);
    if (runningRef.current[conversationId]?.runId === runId) {
      const next = { ...runningRef.current };
      delete next[conversationId];
      runningRef.current = next;
      setRunningByConv(next);
    }
    void settledRef.current().catch(() => undefined);
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => { void settledRef.current().catch(() => undefined); }, 700);
  }, []);

  const attachRunStream = useCallback((runId: string, conversationId: string, startedAt: number) => {
    if (streamsRef.current.has(runId) || finalizedRef.current.has(runId)) return;
    const controller = new AbortController();
    const context = { controller, conversationId, startedAt };
    streamsRef.current.set(runId, context);
    // A fresh physical stream replays its entire backlog; reset, don't append it to the previous partial turn.
    liveTurnsRef.current.set(runId, { ...EMPTY_TURN, startedAt, statusLabel: t('chat.running') });
    if (viewConvRef.current === conversationId) setTurn(liveTurnsRef.current.get(runId)!);
    const tools: ToolCall[] = [];
    let terminal = false;
    let exhausted = false;
    let artifacts: RunArtifact[] | undefined;
    const updateTool = (ev: { id: string; name: string; input?: unknown; parentToolUseId?: string; subagentType?: string }, pending: boolean, output?: string) => {
      let call = tools.find((item) => item.id === ev.id);
      if (!call) { call = { id: ev.id, name: ev.name }; tools.push(call); }
      Object.assign(call, { name: ev.name, input: ev.input, pending });
      if (ev.parentToolUseId) call.parentToolUseId = ev.parentToolUseId;
      if (ev.subagentType) call.subagentType = ev.subagentType;
      if (output !== undefined) call.result = output;
      updateRunTurn(runId, (value) => ({
        ...value, thinking: false, statusLabel: '', toolCalls: tools.map((item) => ({ ...item })),
        items: call?.parentToolUseId || value.items.some((item) => item.kind === 'tool' && item.id === ev.id)
          ? value.items : [...value.items, { kind: 'tool', id: ev.id }],
      }));
    };
    const handlers: RunStreamHandlers = {
      onStatus: (label) => {
        if (label === t('chat.agentStarted')) dispatchReconnect({ kind: 'transport', runId, conversationId, attempt: 0, max: 3, phase: 'cleared' });
        updateRunTurn(runId, (value) => ({ ...value, statusLabel: label }));
      },
      onTextDelta: (delta, parentId) => {
        if (parentId) {
          const call = tools.find((item) => item.id === parentId);
          if (call) { call.liveText = (call.liveText ?? '') + delta; updateRunTurn(runId, (value) => ({ ...value, toolCalls: tools.map((item) => ({ ...item })) })); }
        } else updateRunTurn(runId, (value) => ({ ...value, thinking: false, statusLabel: '', items: appendDelta(value.items, 'text', delta) }));
      },
      onThinkingDelta: (delta) => updateRunTurn(runId, (value) => ({ ...value, thinking: true, items: appendDelta(value.items, 'thinking', delta) })),
      onToolUse: (ev) => updateTool(ev, false),
      onToolInFlight: (ev) => updateTool(ev, true, ev.output),
      onToolResult: (ev) => {
        const call = tools.find((item) => item.id === ev.toolUseId);
        if (call) { Object.assign(call, { result: ev.content, isError: ev.isError, pending: false }); updateRunTurn(runId, (value) => ({ ...value, toolCalls: tools.map((item) => ({ ...item })) })); }
      },
      onReconnect: (signal) => {
        exhausted = signal.phase === 'exhausted';
        dispatchReconnect({ kind: 'transport', runId, conversationId, ...signal });
      },
      onError: (error) => {
        // Transport exhaustion is NOT a daemon terminal frame. Keep the background run and manual retry alive.
        if (exhausted) return;
        terminal = true;
        updateRunTurn(runId, (value) => ({ ...value, error }));
        dispatchReconnect({ kind: 'settled', runId, status: 'failed' });
      },
      onEnd: (payload) => { terminal = true; artifacts = payload.artifacts; dispatchReconnect({ kind: 'settled', runId, status: payload.status }); },
    };
    void (async () => {
      try {
        await streamRunEvents(runId, handlers, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;
        if (terminal) finalizeRun(runId, conversationId, startedAt, artifacts);
        else if (!controller.signal.aborted && !exhausted) {
          // A clean EOF without end is also a disconnected stream, not a successful run.
          dispatchReconnect({ kind: 'transport', runId, conversationId, attempt: 3, max: 3, phase: 'exhausted' });
        }
      } catch {
        if (mountedRef.current && !controller.signal.aborted) dispatchReconnect({ kind: 'transport', runId, conversationId, attempt: 3, max: 3, phase: 'exhausted' });
      } finally {
        if (streamsRef.current.get(runId) === context) streamsRef.current.delete(runId);
      }
    })();
  }, [dispatchReconnect, finalizeRun, updateRunTurn]);

  const registerRun = useCallback((runId: string, conversationId: string, startedAt: number) => {
    const next = { ...runningRef.current, [conversationId]: { runId, startedAt } };
    runningRef.current = next;
    setRunningByConv(next);
    attachRunStream(runId, conversationId, startedAt);
  }, [attachRunStream]);

  useEffect(() => {
    viewConvRef.current = currentConvId;
    const currentReconnect = reconnectByConvRef.current.get(currentConvId ?? '') ?? null;
    reconnectRef.current = currentReconnect;
    setReconnect(currentReconnect);
    const active = runningByConv[currentConvId ?? ''];
    setTurn(active ? liveTurnsRef.current.get(active.runId) ?? { ...EMPTY_TURN, startedAt: active.startedAt } : EMPTY_TURN);
    if (active) attachRunStream(active.runId, currentConvId!, active.startedAt);
  }, [currentConvId, runningByConv, attachRunStream]);

  useEffect(() => {
    mountedRef.current = true;
    const bootstrap = new AbortController();
    void fetch('/api/runs', { signal: bootstrap.signal }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { runs?: { id: string; conversationId: string; status: string; createdAt: number }[] };
      if (bootstrap.signal.aborted) return;
      for (const run of data.runs ?? []) {
        if (run.status === 'running' || run.status === 'queued') registerRun(run.id, run.conversationId, run.createdAt);
      }
    }).catch(() => undefined);
    return () => {
      mountedRef.current = false;
      bootstrap.abort();
      for (const stream of streamsRef.current.values()) stream.controller.abort();
      streamsRef.current.clear();
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [registerRun]);

  const handleManualReconnect = useCallback(() => {
    const active = runningRef.current[viewConvRef.current ?? ''];
    if (!active || !reconnectRef.current?.exhausted) return;
    dispatchReconnect({ kind: 'manual-retry', runId: active.runId });
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => dispatchReconnect({ kind: 'manual-retry-expired', runId: active.runId }), MANUAL_RECONNECT_FEEDBACK_MS);
    attachRunStream(active.runId, viewConvRef.current!, active.startedAt);
  }, [attachRunStream, dispatchReconnect]);

  const stopRun = useCallback(async () => {
    const conversationId = viewConvRef.current;
    const active = runningRef.current[conversationId ?? ''];
    if (!active || !conversationId) return;
    updateRunTurn(active.runId, (value) => ({ ...value, statusLabel: t('chat.stopping') }));
    try {
      await cancelRun(active.runId);
      updateRunTurn(active.runId, (value) => ({ ...value, stopped: true }));
      streamsRef.current.get(active.runId)?.controller.abort();
      dispatchReconnect({ kind: 'dropped', runId: active.runId });
      finalizeRun(active.runId, conversationId, active.startedAt);
    } catch (error) {
      updateRunTurn(active.runId, (value) => ({ ...value, error: error instanceof Error ? error.message : t('chat.stopFailed') }));
    }
  }, [dispatchReconnect, finalizeRun, updateRunTurn]);

  return { messages, setMessages, turn, setTurn, runningByConv, runningRef, viewConvRef, registerRun, stopRun, handleManualReconnect,
    reconnectView: reconnectViewForConversation(reconnect, currentConvId), dispatchReconnect };
}
