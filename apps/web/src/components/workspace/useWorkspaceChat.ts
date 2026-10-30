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
import type { AgentInfo, ChatAttachment, Conversation, Project } from '@remixclip/contracts';
import {
  buildTranscript,
  createConversation,
  createProject,
  createRun,
  deleteConversation,
  deleteProject,
  fetchAppConfig,
  listAgents,
  listConversations,
  listMessages,
  listProjects,
  putAppConfig,
  updateProject,
} from '@/providers/daemon';
import { EMPTY_TURN, mergeMessages } from '@/components/chat/chat-types';
import { t, useI18n } from '@/i18n';
import { useWorkspaceRuns } from './useWorkspaceRuns';

export type SendOptions = { preserveDraft?: boolean; attachments?: ChatAttachment[] };
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
  const refreshConversations = useCallback(async () => {
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    setConversations(await listConversations(projectId));
  }, []);
  const runs = useWorkspaceRuns(currentConvId, refreshConversations);
  const { viewConvRef, setMessages, setTurn, dispatchReconnect } = runs;
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
        setAgentIdState(config?.agentId ?? null);
        setModel((config?.agentId ? config.agentModels?.[config.agentId] : '') ?? '');
        const stored = readStoredProjectId();
        const selected = projectList.find((item) => item.id === stored) ?? projectList[0] ?? null;
        setProjects(projectList);
        setActiveProjectId(selected?.id ?? null);
        activeProjectIdRef.current = selected?.id ?? null;
        setConversations(selected ? await listConversations(selected.id) : []);
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
    setCurrentConvId(id); setLoadedConversationId(null); setMessages([]); setWorkflowError('');
    resetFollowRef.current();
    try {
      const history = await listMessages(projectId, id);
      if (request !== loadRequestRef.current || viewConvRef.current !== id) return;
      // A terminal stream can finish during the history request. Merge by run instead of overwriting its final turn.
      setMessages((previous) => mergeMessages(history, previous.filter((message) => message.conversationId === id)));
      setLoadedConversationId(id);
    } catch (error) {
      if (request === loadRequestRef.current) setWorkflowError(error instanceof Error ? error.message : t('errors.loadConversation'));
    }
  }, [setMessages, viewConvRef]);

  const startNewChat = useCallback(() => {
    ++loadRequestRef.current; ++navigationRef.current;
    viewConvRef.current = null;
    setCurrentConvId(null); setLoadedConversationId(null); setMessages([]); setTurn(EMPTY_TURN);
    dispatchReconnect({ kind: 'dropped' }); resetFollowRef.current();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [dispatchReconnect, setMessages, setTurn, viewConvRef]);

  /** Switch the active project: its conversations replace the current list, the view resets. */
  const switchProject = useCallback(async (id: string) => {
    if (id === activeProjectIdRef.current) return;
    setActiveProjectId(id);
    startNewChat();
    setWorkflowError('');
    try {
      setConversations(await listConversations(id));
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.loadWorkspace'));
    }
  }, [setActiveProjectId, startNewChat]);

  /**
   * Create a project and land in it. The daemon creates the project together with its seed
   * conversation, so the new project opens on a ready-to-type chat instead of an empty list.
   */
  const addProject = useCallback(async (name: string): Promise<Project | null> => {
    setWorkflowError('');
    try {
      const { project, conversation } = await createProject({ name, locale });
      setProjects((previous) => [project, ...previous.filter((item) => item.id !== project.id)]);
      setActiveProjectId(project.id);
      setConversations([conversation]);
      await loadConversation(conversation.id);
      return project;
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.createProject'));
      return null;
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
        startNewChat();
        setConversations(next ? await listConversations(next.id) : []);
      }
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : t('errors.deleteProject'));
    }
  }, [projects, setActiveProjectId, startNewChat]);

  const removeConversation = useCallback(async (id: string) => {
    const projectId = activeProjectIdRef.current;
    if (!projectId || runs.runningRef.current[id] || !window.confirm(t('workspace.confirmDelete'))) return;
    setWorkflowError('');
    try {
      await deleteConversation(projectId, id);
      setQueued((items) => items.filter((item) => item.key !== id));
      if (viewConvRef.current === id) startNewChat();
      await refreshConversations();
    } catch (error) { setWorkflowError(error instanceof Error ? error.message : t('errors.deleteConversation')); }
  }, [refreshConversations, runs.runningRef, startNewChat, viewConvRef]);

  const sendText = useCallback(async (text: string, options: SendOptions = {}): Promise<boolean> => {
    const attachments = options.attachments ?? [];
    if (!text && !attachments.length) return false;
    const projectId = activeProjectIdRef.current;
    if (!projectId) {
      setWorkflowError(t('errors.noProject'));
      return false;
    }
    const conversationId = currentConvId;
    if (conversationId && (loadedConversationId !== conversationId || viewConvRef.current !== conversationId)) return false;
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
    const history = runs.messages;
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
      const result = await createRun({
        agentId: agentId ?? undefined, model, message: buildTranscript(history, text), currentPrompt: text,
        conversationId: targetConvId, projectId,
        attachments: attachments.length ? attachments : undefined,
        locale,
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
  }, [agentId, currentConvId, loadedConversationId, locale, model, refreshConversations, refreshProjects, runs.messages, runs.registerRun, runs.runningRef, setMessages, setTurn, viewConvRef]);

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

  return { ...runs, currentConvId, loadedConversationId, conversations, setConversations,
    workflowError, setWorkflowError, agents, agentsLoading, refreshAgents,
    agentId, activeAgent, selectAgent, model, setModel: chooseModel,
     projects, activeProject, activeProjectId, projectsLoading, switchProject, addProject, renameProject, removeProject, refreshProjects,
    inputText, setInputText, inputRef, queued, setQueued, currentKey, isRunning,
    loadConversation, startNewChat, removeConversation, sendText, sendTextRef, refreshConversations, resetFollowRef };
}

export type WorkspaceChat = ReturnType<typeof useWorkspaceChat>;
