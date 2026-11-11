'use client';

/**
 * [INPUT]: daemon projects, conversations and the globally selected local agent.
 * [OUTPUT]: Project switching/creation, global agent selection, attachment-aware sending,
 *           per-conversation queue and draft state.
 * [POS]: Workspace chat orchestration; presentation stays in components.
 *
 * Model (aligned with open-design):
 *   - the local agent is a GLOBAL preference (`app-config.agentId`), not a per-chat profile;
 *   - a project is the container: it owns conversations, instructions and the working dir;
 *   - a conversation belongs to exactly one project and inherits its agent at run time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, ChatAttachment, Conversation, LibraryItemSummary, Project, ProjectMetadata } from '@remixclip/contracts';
import {
  createConversation,
  createProject,
  createRun,
  deleteProject,
  fetchAppConfig,
  listAgents,
  listConversations,
  listMessages,
  listProjects,
  putAppConfig,
  updateProject,
} from '@/providers/daemon';
import { EMPTY_TURN, mergeMessages, withTurnProcess, type UiMessage } from '@/components/chat/chat-types';
import { t, useI18n } from '@/i18n';
import { useWorkspaceRuns } from './useWorkspaceRuns';

export type SendOptions = {
  preserveDraft?: boolean;
  attachments?: ChatAttachment[];
  /**
   * Land the message in an explicit project/chat. Used by out-of-composer entries (library
   * "replicate") that just created the project and cannot wait for state to settle.
   */
  projectId?: string;
  conversationId?: string;
  /**
   * Out-of-composer requirements (library "补充要求"). Travels as a run field so the daemon
   * injects it into the prompt without it ever entering the chat transcript.
   */
  guidance?: string;
};

/** `startChatWithMessage` also creates the project, so it takes the project's metadata and name. */
export type StartChatOptions = SendOptions & { metadata?: Partial<ProjectMetadata>; name?: string };
export type QueuedMessage = SendOptions & { text: string; key: string; id?: string };

const PROJECT_STORAGE_KEY = 'remixclip:active-project';

function readStoredProjectId(): string | null {
  try {
    return window.localStorage.getItem(PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeProjectId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(PROJECT_STORAGE_KEY, id);
    else window.localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // Ignored in private mode
  }
}

export function useWorkspaceChat() {
  const { locale } = useI18n();
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [loadedConversationId, setLoadedConversationId] = useState<string | null>(null);
  /**
   * True while a conversation's history is being fetched and nothing usable is on screen yet.
   * The chat pane must render a quiet loader instead of its "empty conversation" logo state:
   * a local round-trip is fast enough that the logo would only flash for a few frames.
   */
  const [historyLoading, setHistoryLoading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState('');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  // The first probe runs version commands for 29 CLIs serially/concurrently; the UI needs a skeleton state, not a fake 'no agent installed' empty.
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [agentId, setAgentIdState] = useState<string | null>(null);
  // Empty string = let the CLI pick its own default model. Only filled when the user explicitly picks one.
  const [model, setModel] = useState('');
  const [inputText, setInputText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resetFollowRef = useRef<() => void>(() => undefined);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [startingKeys, setStartingKeys] = useState<Set<string>>(() => new Set());
  const sendingKeysRef = useRef(new Set<string>());
  const pausedQueueKeysRef = useRef(new Set<string>());
  const loadRequestRef = useRef(0);
  // Also changes for new chats: an asynchronous creation must not steal a different fresh view.
  const navigationRef = useRef(0);
  const activeProjectIdRef = useRef<string | null>(null);
  // Defined below: the mount effect runs before `loadConversation` is in scope at module order,
  // but after the hook body executed, so a ref is the simplest way to reach it.
  const loadConversationRef = useRef<(id: string) => Promise<void>>(async () => undefined);
  const refreshConversations = useCallback(async () => {
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    setConversations(await listConversations(projectId));
  }, []);
  const runs = useWorkspaceRuns(currentConvId, refreshConversations);
  const { viewConvRef, setMessages, setTurn, dispatchReconnect } = runs;
  /**
   * One-entry-per-conversation cache, so returning to a project paints its last known history
   * immediately while the fresh copy is fetched in the background. Without it, every switch
   * cleared the log and rendered the blank/logo state for one network round-trip.
   */
  const messageCacheRef = useRef(new Map<string, UiMessage[]>());
  useEffect(() => {
    if (!currentConvId || loadedConversationId !== currentConvId) return;
    const cache = messageCacheRef.current;
    if (!cache.has(currentConvId) && cache.size >= 12) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    cache.set(currentConvId, runs.messages);
  }, [currentConvId, loadedConversationId, runs.messages]);
  const activeProject = projects.find((project) => project.id === activeProjectId) ?? null;
  const activeAgent = agents.find((agent) => agent.id === agentId) ?? null;
  const currentKey = currentConvId ?? 'new';
  const currentRun = currentConvId ? runs.runningByConv[currentConvId] : undefined;
  const isRunning = startingKeys.has(currentKey) || !!currentRun;

  const setActiveProjectId = useCallback((id: string | null) => {
    activeProjectIdRef.current = id;
    setActiveProjectIdState(id);
    storeProjectId(id);
  }, []);

  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    const list = await listProjects();
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([listAgents(), fetchAppConfig().catch(() => null), listProjects()])
      .then(async ([agentList, config, projectList]) => {
        if (disposed) return;
        setAgents(agentList);
        // A removed runtime can linger in a saved config; treat an unknown id as "not connected".
        const savedAgentId = config?.agentId && agentList.some((agent) => agent.id === config.agentId)
          ? config.agentId
          : null;
        setAgentIdState(savedAgentId);
        setModel((savedAgentId ? config?.agentModels?.[savedAgentId] : '') ?? '');
        const stored = readStoredProjectId();
        const selected = projectList.find((item) => item.id === stored) ?? projectList[0] ?? null;
        setProjects(projectList);
        setActiveProjectId(selected?.id ?? null);
        activeProjectIdRef.current = selected?.id ?? null;
        const initialConversations = selected ? await listConversations(selected.id) : [];
        setConversations(initialConversations);
        // 1:1 — opening a project means opening its chat; there is no "pick a thread" step.
        if (initialConversations[0]) await loadConversationRef.current(initialConversations[0].id);
        setAgentsLoading(false);
        setProjectsLoading(false);
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setAgentsLoading(false);
        setProjectsLoading(false);
        setWorkflowError(error instanceof Error ? error.message : t('errors.loadWorkspace'));
      });
    return () => { disposed = true; };
  }, [setActiveProjectId]);

  /** Re-probe local CLIs (force bypasses the daemon's 30s cache). */
  const refreshAgents = useCallback(async () => {
    setAgentsLoading(true);
    try {
      setAgents(await listAgents(true));
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  /** Connect (select) a local agent globally; persisted to app-config so the next turn uses it. */
  const selectAgent = useCallback(async (nextAgentId: string, nextModel?: string) => {
    const previousId = agentId;
    const previousModel = model;
    setAgentIdState(nextAgentId);
    if (nextModel !== undefined) setModel(nextModel);
    try {
      const saved = await putAppConfig({
        agentId: nextAgentId,
        ...(nextModel !== undefined ? { agentModels: { [nextAgentId]: nextModel } } : {}),
      });
      setModel((nextModel ?? saved.agentModels?.[nextAgentId]) ?? '');
    } catch (error) {
      setAgentIdState(previousId);
      setModel(previousModel);
      setWorkflowError(error instanceof Error ? error.message : t('errors.appConfigPutHttp', { status: 0 }));
    }
  }, [agentId, model]);

  /** Remember the model per agent ('' = CLI default). */
  const chooseModel = useCallback((nextModel: string) => {
    setModel(nextModel);
    if (!agentId) return;
    void putAppConfig({ agentModels: { [agentId]: nextModel } }).catch(() => undefined);
  }, [agentId]);

  const loadConversation = useCallback(async (id: string) => {
    // Conversations are only addressable through their project; the list is project-scoped,
    // so the active project is the one that owns this id.
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    const request = ++loadRequestRef.current;
    ++navigationRef.current;
    viewConvRef.current = id;
    // Cached conversations paint instantly; only a true first open needs the loader. The fresh
    // copy always replaces it once it arrives, so the visible log converges either way.
    const cached = messageCacheRef.current.get(id);
    // An empty cached log is treated like a miss: it may have gained messages while we were away,
    // and rendering the empty state first would flash the logo again.
    setCurrentConvId(id); setLoadedConversationId(null); setMessages(cached ?? []);
    setHistoryLoading(!cached || cached.length === 0); setWorkflowError('');
    resetFollowRef.current();
    try {
      const history = (await listMessages(projectId, id)).map(withTurnProcess);
      if (request !== loadRequestRef.current || viewConvRef.current !== id) return;
      // A terminal stream can finish during the history request. Merge by run instead of overwriting its final turn.
      setMessages((previous) => mergeMessages(history, previous.filter((message) => message.conversationId === id)));
      setLoadedConversationId(id);
    } catch (error) {
      if (request === loadRequestRef.current) setWorkflowError(error instanceof Error ? error.message : t('errors.loadConversation'));
    } finally {
      // A newer navigation owns the flag now; only the request that still matches may clear it.
      if (request === loadRequestRef.current) setHistoryLoading(false);
    }
  }, [setMessages, viewConvRef]);

  const startNewChat = useCallback(() => {
    ++loadRequestRef.current; ++navigationRef.current;
    viewConvRef.current = null;
    setCurrentConvId(null); setLoadedConversationId(null); setMessages([]); setTurn(EMPTY_TURN);
    setHistoryLoading(false);
    dispatchReconnect({ kind: 'dropped' }); resetFollowRef.current();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [dispatchReconnect, setMessages, setTurn, viewConvRef]);
  loadConversationRef.current = loadConversation;

  /** Switch the active project and open its one conversation (empty compose when it has none). */
  const switchProject = useCallback(async (id: string) => {
    if (id === activeProjectIdRef.current) return;
    setActiveProjectId(id);
    // Cover the conversation-list round-trip too: without this the old project's log sits under
    // the new project's header for a few frames before loadConversation takes over.
    setHistoryLoading(true);
    setWorkflowError('');
    try {
      const next = await listConversations(id);
      setConversations(next);
      if (next[0]) await loadConversationRef.current(next[0].id);
      else startNewChat();
    } catch (error) {
      startNewChat();
      setWorkflowError(error instanceof Error ? error.message : t('errors.loadWorkspace'));
    }
  }, [setActiveProjectId, startNewChat]);

  /**
   * Create a project FROM material — the only kind of project this app has. Every selected id
   * travels in the metadata (`sourceLibraryItemIds`), which is what makes the daemon copy each
   * source into `<projectDir>/reference/` before the first turn; without that folder a recreation
   * would have nothing local to read. The dialog requires at least one item, so `ids` is non-empty.
   */
  const addRecreationProject = useCallback(async (name: string, items: LibraryItemSummary[]): Promise<Project> => {
    setWorkflowError('');
    const ids = [...new Set(items.map((item) => item.id))];
    if (!ids.length) throw new Error(t('errors.pickMaterialsFirst'));
    try {
      const { project, conversation } = await createProject({
        name: name.trim() || items[0]?.title.slice(0, 40) || t('sidebar.untitledProject'),
        locale,
        // Keep the single-id field for older daemons/readers; the plural one is authoritative.
        metadata: { kind: 'video', sourceLibraryItemIds: ids, sourceLibraryItemId: ids[0] },
      });
      setProjects((previous) => [project, ...previous.filter((item) => item.id !== project.id)]);
      setActiveProjectId(project.id);
      setConversations([conversation]);
      await loadConversation(conversation.id);
      return project;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.createProject');
      setWorkflowError(message);
      throw new Error(message);
    }
  }, [loadConversation, locale, setActiveProjectId]);

  const renameProject = useCallback(async (id: string, name: string) => {
    try {
      const updated = await updateProject(id, { name });
      setProjects((previous) => previous.map((project) => (project.id === id ? updated : project)));
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.updateProject'));
    }
  }, []);

  const removeProject = useCallback(async (id: string) => {
    setWorkflowError('');
    try {
      await deleteProject(id);
      const remaining = projects.filter((project) => project.id !== id);
      setProjects(remaining);
      if (activeProjectIdRef.current === id) {
        const next = remaining[0] ?? null;
        setActiveProjectId(next?.id ?? null);
        setHistoryLoading(true);
        const nextConversations = next ? await listConversations(next.id) : [];
        setConversations(nextConversations);
        if (nextConversations[0]) await loadConversationRef.current(nextConversations[0].id);
        else startNewChat();
      }
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.deleteProject'));
      // The deleted project's log must not stay under a header that no longer has a home.
      startNewChat();
    }
  }, [projects, setActiveProjectId, startNewChat]);

  const sendText = useCallback(async (text: string, options: SendOptions = {}): Promise<boolean> => {
    const attachments = options.attachments ?? [];
    if (!text && !attachments.length) return false;
    let projectId = options.projectId ?? activeProjectIdRef.current;
    /*
     * A project is founded from material: its `reference/` folder is the local source the agent
     * reads. A bare message therefore cannot conjure a project — the new-project dialog owns that
     * decision — so surface the requirement instead of running a turn with nothing to look at.
     */
    if (!projectId) {
      setWorkflowError(t('errors.pickMaterialsFirst'));
      return false;
    }
    // An explicit conversation (caller just created it) wins over whatever the view happens to
    // show; otherwise this turn lands in the open chat. 1:1 means a project without a chat yet
    // lazily gets its one chat here.
    const explicitConversationId = options.conversationId ?? null;
    const conversationId = explicitConversationId ?? currentConvId;
    // An explicit conversation is ours alone, so it needs no freshness check against the view.
    if (!explicitConversationId && conversationId && (loadedConversationId !== conversationId || viewConvRef.current !== conversationId)) return false;
    const sendKey = conversationId ?? 'new';
    pausedQueueKeysRef.current.delete(sendKey);
    if (sendingKeysRef.current.has(sendKey) || runs.runningRef.current[conversationId ?? '']) {
      setQueued((items) => [...items, { ...options, attachments, text, key: sendKey, id: crypto.randomUUID() }]);
      if (!options.preserveDraft) setInputText('');
      return true;
    }
    sendingKeysRef.current.add(sendKey);
    setStartingKeys((keys) => new Set(keys).add(sendKey));
    const navigation = navigationRef.current;
    if (!options.preserveDraft) setInputText('');
    setWorkflowError('');
    let targetConvId = conversationId;
    let activeKey = sendKey;
    let optimisticId: string | undefined;
    try {
      if (!targetConvId) {
        const created = await createConversation({
          title: text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 40) || attachments[0]?.name || t('workspace.newChatTitle'),
          projectId,
          locale,
        });
        targetConvId = created.id;
        setConversations((previous) => [created, ...previous.filter((item) => item.id !== created.id)]);
        if (navigation === navigationRef.current && viewConvRef.current === null && activeProjectIdRef.current === projectId) {
          viewConvRef.current = created.id; setCurrentConvId(created.id); setLoadedConversationId(created.id);
        }
        sendingKeysRef.current.delete(sendKey); sendingKeysRef.current.add(created.id); activeKey = created.id;
        setStartingKeys((keys) => { const next = new Set(keys); next.delete(sendKey); next.add(created.id); return next; });
        setQueued((items) => items.map((item) => item.key === sendKey ? { ...item, key: created.id } : item));
      }
      const startedAt = Date.now();
      if (viewConvRef.current === targetConvId) {
        resetFollowRef.current(); setTurn({ ...EMPTY_TURN, startedAt, statusLabel: t('workspace.creatingRun') });
        optimisticId = `user-${crypto.randomUUID()}`;
        setMessages((previous) => [...previous, { id: optimisticId!, conversationId: targetConvId!, role: 'user', content: text, attachments: attachments.length ? attachments : undefined, createdAt: startedAt }]);
      }
      // Only this turn's text goes over the wire: the daemon decides between resuming the
      // agent's upstream session and replaying the (agent-scoped) history from SQLite.
      const result = await createRun({
        agentId: agentId ?? undefined, model, message: text, currentPrompt: text,
        conversationId: targetConvId, projectId,
        attachments: attachments.length ? attachments : undefined,
        locale,
        guidance: options.guidance,
      });
      if (optimisticId) setMessages((previous) => previous.map((item) => item.id === optimisticId ? { ...item, runId: result.runId } : item));
      runs.registerRun(result.runId, result.conversationId, startedAt);
      void refreshConversations().catch(() => undefined);
      void refreshProjects().catch(() => undefined);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t('errors.createRun');
      setWorkflowError(message);
      if (viewConvRef.current === targetConvId) {
        // Failed sends are not persisted: remove the optimistic bubble so retry won't poison the transcript.
        if (optimisticId) setMessages((previous) => previous.filter((item) => item.id !== optimisticId));
        setTurn(EMPTY_TURN);
        if (!options.preserveDraft) setInputText((draft) => draft || text);
      }
      return false;
    } finally {
      sendingKeysRef.current.delete(activeKey);
      setStartingKeys((keys) => { const next = new Set(keys); next.delete(activeKey); return next; });
    }
  }, [agentId, currentConvId, loadedConversationId, locale, model, refreshConversations, refreshProjects, runs.registerRun, runs.runningRef, setActiveProjectId, setMessages, setTurn, viewConvRef]);

  /**
   * Start a brand-new chat from an out-of-composer entry point (library "replicate"). In the 1:1
   * model a new chat is a new PROJECT: it is created with its seed conversation, which is exactly
   * where this first message lands.
   */
  const startChatWithMessage = useCallback(async (text: string, options: StartChatOptions = {}): Promise<boolean> => {
    setWorkflowError('');
    try {
      const { metadata, name, ...sendOptions } = options;
      const { project, conversation } = await createProject({
        name:
          name?.trim() ||
          text.split('\n').find((line) => line.trim())?.replace(/^#+\s*/, '').trim().slice(0, 40) ||
          t('sidebar.untitledProject'),
        locale,
        metadata,
      });
      setProjects((previous) => [project, ...previous.filter((item) => item.id !== project.id)]);
      setActiveProjectId(project.id);
      setConversations([conversation]);
      // Mirror the new view synchronously: `sendText` may take its optimistic-turn branch only
      // when the ref already points at this conversation.
      viewConvRef.current = conversation.id;
      setCurrentConvId(conversation.id);
      setLoadedConversationId(conversation.id);
      setHistoryLoading(false);
      setMessages([]);
      setTurn(EMPTY_TURN);
      resetFollowRef.current();
      return await sendText(text, {
        ...sendOptions,
        projectId: project.id,
        conversationId: conversation.id,
      });
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.createProject'));
      return false;
    }
  }, [locale, sendText, setActiveProjectId, setMessages, setTurn, viewConvRef]);

  const sendTextRef = useRef(sendText);
  sendTextRef.current = sendText;
  useEffect(() => {
    if (isRunning || sendingKeysRef.current.has(currentKey) || pausedQueueKeysRef.current.has(currentKey)) return;
    if (currentConvId && loadedConversationId !== currentConvId) return;
    const head = queued.find((item) => item.key === currentKey);
    if (!head) return;
    setQueued((items) => items.filter((item) => item !== head));
    // Queue execution never clears text typed after the message was enqueued.
    void sendTextRef.current(head.text, { ...head, preserveDraft: true }).then((sent) => {
      if (!sent) {
        // Keep failed queued files visible and retained, but don't create an automatic retry loop.
        pausedQueueKeysRef.current.add(head.key);
        setQueued((items) => [head, ...items]);
      }
    });
  }, [currentConvId, currentKey, isRunning, loadedConversationId, queued]);

  return { ...runs, currentConvId, loadedConversationId, historyLoading, conversations, setConversations,
    workflowError, setWorkflowError, agents, agentsLoading, refreshAgents,
    agentId, activeAgent, selectAgent, model, setModel: chooseModel,
     projects, activeProject, activeProjectId, projectsLoading, switchProject, addRecreationProject, renameProject, removeProject, refreshProjects,
    inputText, setInputText, inputRef, queued, setQueued, currentKey, isRunning,
    loadConversation, startNewChat, startChatWithMessage, sendText, sendTextRef, refreshConversations, resetFollowRef };
}

export type WorkspaceChat = ReturnType<typeof useWorkspaceChat>;
