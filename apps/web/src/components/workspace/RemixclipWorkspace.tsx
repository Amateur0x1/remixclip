'use client';

/**
 * [INPUT]: Chat/attachment/scroll hooks plus the extracted sidebar and chat-pane components.
 * [OUTPUT]: Chat workspace: project switching + conversation list + main conversation pane,
 *           plus the settings drawer (global local-agent selection).
 * [POS]: App Router workspace container; domain orchestration lives in separate hooks.
 */
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { ChatAttachment } from '@remixclip/contracts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizableGroup, ResizableHandle, ResizablePanel } from '@/components/ui/resizable';
import type { PendingAttachment, SidebarThread } from '@/components/chat/chat-types';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { SettingsDialog } from '@/components/settings/SettingsDialog';
import { useI18n } from '@/i18n';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversationPane } from './ChatConversationPane';
import { LibraryPane } from '@/components/library/LibraryPane';
import type { WorkspaceTab } from './WorkspaceNav';
import { useAttachments } from '@/components/workspace/useAttachments';
import { useStickToBottom } from './useStickToBottom';
import { useWorkspaceChat } from './useWorkspaceChat';

export function RemixclipWorkspace() {
  const { t } = useI18n();
  const chat = useWorkspaceChat();
  const scroll = useStickToBottom(chat.messages, chat.turn);
  chat.resetFollowRef.current = scroll.resetFollow;
  const clearWorkflowError = useCallback(() => chat.setWorkflowError(''), [chat.setWorkflowError]);
  const attachments = useAttachments(clearWorkflowError);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarQuery, setSidebarQuery] = useState('');
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  // Auto-open the settings drawer on first run; stop nagging once the user closes it.
  const settingsAutoOpenedRef = useRef(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarSearchToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarFocusComposerRef = useRef(false);
  const attachmentSendRef = useRef(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 860px)');
    const sync = () => { setSidebarCompact(media.matches); if (!media.matches) setSidebarDrawerOpen(false); };
    sync(); media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  // No agent connected = first use: once detection finishes, put the settings drawer in front of the user.
  useEffect(() => {
    if (settingsAutoOpenedRef.current || chat.agentsLoading || chat.agentId) return;
    settingsAutoOpenedRef.current = true;
    setSettingsOpen(true);
  }, [chat.agentsLoading, chat.agentId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault(); setSidebarCollapsed(false); setSidebarSearchOpen(true);
      if (sidebarCompact) setSidebarDrawerOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarCompact]);

  // Project isolation: the sidebar only ever shows the active project's conversations
  // (the daemon already scopes the list; this keeps rendering independent of that guarantee).
  const sidebarThreads = useMemo<SidebarThread[]>(() => chat.conversations
    .filter((conversation) => chat.activeProjectId !== null && conversation.projectId === chat.activeProjectId)
    .map((conversation) => ({
      id: conversation.id,
      conversationId: conversation.id,
      title: conversation.title.trim() || t('sidebar.untitled'),
      updatedAt: conversation.updatedAt,
      conversation,
    })).sort((a, b) => b.updatedAt - a.updatedAt), [chat.conversations, chat.activeProjectId, t]);

  const sidebarSearchTerms = useMemo(() => sidebarQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), [sidebarQuery]);
  const searchedThreads = useMemo(() => {
    if (sidebarSearchTerms.length === 0) return [];
    const matches = (value: string) => sidebarSearchTerms.every((term) => value.toLocaleLowerCase().includes(term));
    return sidebarThreads.filter((thread) => matches(thread.title));
  }, [sidebarSearchTerms, sidebarThreads]);
  const recentThreads = showAllRecent ? sidebarThreads : sidebarThreads.slice(0, 12);
  const clearSearch = () => { setSidebarSearchOpen(false); setSidebarQuery(''); };

  const closeSidebarForChat = () => {
    sidebarFocusComposerRef.current = sidebarDrawerOpen;
    setSidebarDrawerOpen(false);
    if (!sidebarDrawerOpen) requestAnimationFrame(() => chat.inputRef.current?.focus());
  };
  const selectSidebarThread = (thread: SidebarThread) => {
    if (!thread.conversationId) return;
    setSidebarDrawerOpen(false); clearSearch();
    setActiveTab('chat');
    void chat.loadConversation(thread.conversationId);
  };
  const startNewChat = () => {
    clearSearch(); closeSidebarForChat();
    setActiveTab('chat');
    chat.startNewChat();
  };

  const selectProject = (id: string) => {
    setSidebarDrawerOpen(false); clearSearch();
    setActiveTab('chat');
    void chat.switchProject(id);
  };

  const createProject = async () => {
    const name = newProjectName.trim() || t('sidebar.untitledProject');
    const project = await chat.addProject(name);
    if (!project) return;
    setNewProjectOpen(false);
    setNewProjectName('');
    setActiveTab('chat');
  };

  const sendMessage = () => {
    if (attachmentSendRef.current) return;
    if (attachments.pendingAttachments.some((item: PendingAttachment) => item.uploading || item.error || !item.uploaded)) {
      chat.setWorkflowError(t('workspace.attachmentPending')); return;
    }
    const uploaded = attachments.pendingAttachments.map((item: PendingAttachment) => item.uploaded).filter((item: ChatAttachment | undefined): item is ChatAttachment => !!item);
    const text = chat.inputText.trim();
    if (!text && !uploaded.length) return;
    attachmentSendRef.current = true;
    void chat.sendText(text, { attachments: uploaded }).then((sent) => {
      // Clear only accepted files; preserve attachments added while createRun was pending.
      if (sent) {
        for (const item of attachments.pendingAttachments) attachments.removePendingAttachment(item.clientId);
        attachments.setArmedAttachmentId(null);
      }
    }).finally(() => { attachmentSendRef.current = false; });
  };

  // Empty string = let the CLI pick its own default model.
  const modelOptions = useMemo(() => {
    const values = [...(chat.activeAgent?.models ?? [])];
    if (chat.model && !values.includes(chat.model)) values.unshift(chat.model);
    return [{ value: '', label: t('workspace.cliDefault') }, ...values.map((value) => ({ value, label: value }))];
  }, [chat.model, chat.activeAgent, t]);

  const currentThreadTitle = sidebarThreads.find((thread) => thread.conversationId === chat.currentConvId)?.title ?? t('workspace.newChatTitle');

  const sidebar = <ChatSidebar
    sidebarCompact={sidebarCompact} sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed}
    sidebarDrawerOpen={sidebarDrawerOpen} setSidebarDrawerOpen={setSidebarDrawerOpen}
    sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
    sidebarSearchOpen={sidebarSearchOpen} setSidebarSearchOpen={setSidebarSearchOpen}
    sidebarQuery={sidebarQuery} setSidebarQuery={setSidebarQuery} sidebarSearchTerms={sidebarSearchTerms}
    activeTab={activeTab} onTabChange={setActiveTab}
    projects={chat.projects} projectsLoading={chat.projectsLoading} activeProjectId={chat.activeProjectId}
    onSelectProject={selectProject} onNewProject={() => { setNewProjectName(''); setNewProjectOpen(true); }}
    onRenameProject={(id, name) => void chat.renameProject(id, name)}
    onDeleteProject={(id) => void chat.removeProject(id)}
    agent={chat.activeAgent} agentId={chat.agentId} agentsLoading={chat.agentsLoading}
    onOpenSettings={() => setSettingsOpen(true)}
    recentThreads={recentThreads} sidebarThreads={sidebarThreads}
    showAllRecent={showAllRecent} setShowAllRecent={setShowAllRecent}
    searchedThreads={searchedThreads} currentConvId={chat.currentConvId}
    runningByConv={chat.runningByConv} workflowError={chat.workflowError}
    startNewChat={startNewChat} selectSidebarThread={selectSidebarThread}
    removeConversation={chat.removeConversation}
  />;

  return <div className="flex h-screen flex-col bg-transparent">
    <div className="flex min-h-0 flex-1">
      <ResizableGroup orientation="horizontal" id="remixclip-shell" className="h-full">
        {!sidebarCollapsed && !sidebarCompact && <>
          <ResizablePanel id="nav" defaultSize="19%" minSize="15%" maxSize="32%">
            <aside id="chat-sidebar" data-remixclip-sidebar data-remixclip-chat-sidebar className="flex h-full min-h-0 flex-col bg-sidebar" aria-label={t('sidebar.regionAria')}>{sidebar}</aside>
          </ResizablePanel><ResizableHandle />
        </>}
        <ResizablePanel id="main" minSize="45%">
          <main className="relative flex h-full min-w-0 flex-col">
            {activeTab === 'library' ? (
              <LibraryPane
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
              />
            ) : (
              <ChatConversationPane
                {...chat} {...scroll} {...attachments}
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
                currentThreadTitle={currentThreadTitle} sendMessage={sendMessage} modelOptions={modelOptions}
                projectName={chat.activeProject?.name ?? null}
                agent={chat.activeAgent}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </main>
        </ResizablePanel>
      </ResizableGroup>
    </div>
    <Dialog open={sidebarDrawerOpen && sidebarCompact} onOpenChange={setSidebarDrawerOpen}>
      <DialogContent id="chat-sidebar" data-remixclip-chat-sidebar showCloseButton={false}
        className="left-0 top-0 flex h-dvh w-[280px] max-w-[calc(100vw-3rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-l-0 bg-background p-0 sm:max-w-[280px]"
        onCloseAutoFocus={(event) => { event.preventDefault(); const target = sidebarFocusComposerRef.current ? chat.inputRef.current : sidebarToggleRef.current; sidebarFocusComposerRef.current = false; target?.focus(); }}>
        <DialogTitle className="sr-only">{t('sidebar.drawerTitle')}</DialogTitle>
        <DialogDescription className="sr-only">{t('sidebar.drawerDescription')}</DialogDescription>
        {sidebar}
      </DialogContent>
    </Dialog>
    <ImageLightbox image={attachments.lightboxImage} onClose={() => attachments.setLightboxImage(null)} />
    <SettingsDialog
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      agents={chat.agents}
      agentsLoading={chat.agentsLoading}
      agentId={chat.agentId}
      model={chat.model}
      onRescan={chat.refreshAgents}
      onConnectAgent={(id, model) => chat.selectAgent(id, model)}
      onModelChange={(model) => chat.setModel(model)}
    />
    <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
      <DialogContent className="w-[420px] sm:max-w-[420px]">
        <DialogTitle>{t('sidebar.newProject')}</DialogTitle>
        <DialogDescription className="text-[13px] text-muted-foreground">{t('sidebar.newProjectDesc')}</DialogDescription>
        <Input
          autoFocus
          value={newProjectName}
          placeholder={t('sidebar.projectNamePlaceholder')}
          aria-label={t('sidebar.projectNameAria')}
          onChange={(event) => setNewProjectName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter') { event.preventDefault(); void createProject(); }
          }}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setNewProjectOpen(false)}>{t('common.cancel')}</Button>
          <Button type="button" onClick={() => void createProject()}>{t('common.create')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>;
}
