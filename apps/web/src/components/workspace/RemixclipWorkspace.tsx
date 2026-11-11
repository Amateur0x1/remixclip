'use client';

/**
 * [INPUT]: Chat/attachment/scroll hooks plus the extracted sidebar and chat-pane components.
 * [OUTPUT]: Chat workspace: project switching (one project = one chat) + a main pane that shows
 *           the conversation, the library, or the settings page.
 * [POS]: App Router workspace container; domain orchestration lives in separate hooks.
 */
import { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import type { ChatAttachment, LibraryItemSummary } from '@remixclip/contracts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ResizableGroup, ResizableHandle, ResizablePanel } from '@/components/ui/resizable';
import type { PendingAttachment } from '@/components/chat/chat-types';
import { ImageLightbox } from '@/components/chat/ImageLightbox';
import { SettingsPane } from '@/components/settings/SettingsPane';
import { useI18n } from '@/i18n';
import { projectDisplayName } from '@/lib/project-name';
import { ChatSidebar } from './ChatSidebar';
import { ChatConversationPane } from './ChatConversationPane';
import { LibraryPane } from '@/components/library/LibraryPane';
import { CutsPane } from '@/components/cuts/CutsPane';
import type { WorkspaceTab } from './WorkspaceNav';
import { useAttachments } from '@/components/workspace/useAttachments';
import { useStickToBottom } from './useStickToBottom';
import { useWorkspaceChat } from './useWorkspaceChat';
import { buildRecreationHandoff, buildReplicateHandoff } from '@/lib/replicate-prompt';
import { DownloadsProvider } from '@/components/library/DownloadsCenter';
import { ReplicateDialog } from '@/components/library/ReplicateDialog';
import { NewProjectDialog, type NewProjectInput } from '@/components/library/NewProjectDialog';

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
  // Settings is a destination, not an overlay: it takes over the main pane like the library tab.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  /** Item whose source is not local yet: the download dialog owns the next step. */
  const [pendingReplicate, setPendingReplicate] = useState<LibraryItemSummary | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('chat');
  // Auto-open the new-project dialog while no project exists; stop nagging once it is dismissed.
  const newProjectPromptedRef = useRef(false);
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

  // A project only exists from material, so the empty state is the picker: show it once when the
  // project list finishes empty. Deleting the last project re-arms the prompt.
  useEffect(() => {
    if (chat.projectsLoading || settingsOpen) return;
    if (chat.projects.length > 0) { newProjectPromptedRef.current = false; return; }
    if (newProjectPromptedRef.current) return;
    newProjectPromptedRef.current = true;
    setNewProjectOpen(true);
  }, [chat.projectsLoading, chat.projects.length, settingsOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault(); setSidebarCollapsed(false); setSidebarSearchOpen(true);
      if (sidebarCompact) setSidebarDrawerOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sidebarCompact]);

  // Search only needs to name what the sidebar can show: projects, since each one is a chat.
  const sidebarSearchTerms = useMemo(() => sidebarQuery.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean), [sidebarQuery]);
  const clearSearch = () => { setSidebarSearchOpen(false); setSidebarQuery(''); };

  const closeSidebarForChat = () => {
    sidebarFocusComposerRef.current = sidebarDrawerOpen;
    setSidebarDrawerOpen(false);
    if (!sidebarDrawerOpen) requestAnimationFrame(() => chat.inputRef.current?.focus());
  };
  const selectProject = (id: string) => {
    setSidebarDrawerOpen(false); clearSearch();
    setSettingsOpen(false);
    setActiveTab('chat');
    void chat.switchProject(id);
  };

  const createMaterialProject = async ({ name, items }: NewProjectInput) => {
    // Errors bubble back to the dialog, which keeps itself open and shows the reason. The handoff
    // also proves every source is local (the dialog downloaded whatever was missing).
    const handoff = await buildRecreationHandoff(items);
    await chat.addRecreationProject(name, items);
    // The project now owns `reference/` copies of these clips: leave the recreation brief in the
    // composer so the first turn starts from the sources instead of a blank box.
    chat.setInputText(handoff.prompt);
    setSettingsOpen(false);
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

  /**
   * Library right-click → a fresh recreation project whose first message is the brief.
   *
   * The item id travels with the project (metadata.sourceLibraryItemId): that is what makes the
   * daemon copy the source clip into `<projectDir>/reference/` before the agent runs. With no
   * downloaded source there is nothing to copy, so the dialog's footer downloads it instead of
   * handing the agent a post URL it cannot fetch.
   */
  const startReplicate = (item: LibraryItemSummary, guidance: string) => {
    void buildReplicateHandoff(item, guidance)
      .then((handoff) => {
        if (!handoff.referenceName) {
          // The dialog only enables 开始复刻 once the clip is local; this reopens it if the media
          // disappeared in between (e.g. a deleted cache) instead of firing an empty handoff.
          setPendingReplicate(item);
          return;
        }
        setActiveTab('chat');
        return chat.startChatWithMessage(handoff.prompt, {
          preserveDraft: true,
          // Injected-only: the transcript shows the brief, the agent also gets the constraints.
          guidance: handoff.guidance,
          name: item.title.slice(0, 40),
          metadata: { kind: 'video', sourceLibraryItemId: handoff.libraryItemId },
        });
      })
      .catch((error: unknown) => {
        chat.setWorkflowError(error instanceof Error ? error.message : t('errors.createRun'));
      });
  };

  const replicateLibraryItem = (item: LibraryItemSummary) => {
    clearSearch(); closeSidebarForChat();
    setSettingsOpen(false);
    // Always confirm: the dialog is where the optional guidance is typed, and where a missing
    // source clip becomes a download rather than a dead end.
    setPendingReplicate(item);
  };

  // Empty string = let the CLI pick its own default model.
  const modelOptions = useMemo(() => {
    const values = [...(chat.activeAgent?.models ?? [])];
    if (chat.model && !values.includes(chat.model)) values.unshift(chat.model);
    return [{ value: '', label: t('workspace.cliDefault') }, ...values.map((value) => ({ value, label: value }))];
  }, [chat.model, chat.activeAgent, t]);

  // 1:1 — the project IS the chat, so the header shows the project name: renaming the row
  // renames what the main pane says too.
  const currentThreadTitle = projectDisplayName(chat.activeProject, t) || t('workspace.newChatTitle');

  const sidebar = <ChatSidebar
    sidebarCompact={sidebarCompact} sidebarCollapsed={sidebarCollapsed} setSidebarCollapsed={setSidebarCollapsed}
    sidebarDrawerOpen={sidebarDrawerOpen} setSidebarDrawerOpen={setSidebarDrawerOpen}
    sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
    sidebarSearchOpen={sidebarSearchOpen} setSidebarSearchOpen={setSidebarSearchOpen}
    sidebarQuery={sidebarQuery} setSidebarQuery={setSidebarQuery} sidebarSearchTerms={sidebarSearchTerms}
    activeTab={activeTab} onTabChange={(tab) => { setSettingsOpen(false); setActiveTab(tab); }}
    settingsOpen={settingsOpen}
    projects={chat.projects} projectsLoading={chat.projectsLoading} activeProjectId={chat.activeProjectId}
    onSelectProject={selectProject} onNewProject={() => setNewProjectOpen(true)}
    onRenameProject={(id, name) => void chat.renameProject(id, name)}
    onDeleteProject={(id) => void chat.removeProject(id)}
    agent={chat.activeAgent} agentId={chat.agentId} agentsLoading={chat.agentsLoading}
    onOpenSettings={() => setSettingsOpen(true)}
    runningProjectId={chat.isRunning ? chat.activeProjectId : null}
    workflowError={chat.workflowError}
  />;

  return <DownloadsProvider>
  <div className="flex h-screen flex-col bg-transparent">
    <div className="flex min-h-0 flex-1">
      <ResizableGroup orientation="horizontal" id="remixclip-shell" className="h-full">
        {!sidebarCollapsed && !sidebarCompact && <>
          <ResizablePanel id="nav" defaultSize="19%" minSize="15%" maxSize="32%">
            <aside id="chat-sidebar" data-remixclip-sidebar data-remixclip-chat-sidebar className="flex h-full min-h-0 flex-col bg-sidebar" aria-label={t('sidebar.regionAria')}>{sidebar}</aside>
          </ResizablePanel><ResizableHandle />
        </>}
        <ResizablePanel id="main" minSize="45%">
          <main className="relative flex h-full min-w-0 flex-col">
            {settingsOpen ? (
              <SettingsPane
                onClose={() => setSettingsOpen(false)}
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef}
                agents={chat.agents} agentsLoading={chat.agentsLoading} agentId={chat.agentId} model={chat.model}
                onRescan={chat.refreshAgents}
                onConnectAgent={(id) => chat.selectAgent(id)}
              />
            ) : activeTab === 'library' ? (
              <LibraryPane
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
                onReplicate={replicateLibraryItem}
              />
            ) : activeTab === 'cuts' ? (
              <CutsPane
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
                onOpenProject={selectProject}
              />
            ) : (
              <ChatConversationPane
                {...chat} {...scroll} {...attachments}
                sidebarCollapsed={sidebarCollapsed} sidebarCompact={sidebarCompact} sidebarDrawerOpen={sidebarDrawerOpen}
                setSidebarCollapsed={setSidebarCollapsed} setSidebarDrawerOpen={setSidebarDrawerOpen}
                sidebarToggleRef={sidebarToggleRef} sidebarSearchToggleRef={sidebarSearchToggleRef}
                currentThreadTitle={currentThreadTitle} sendMessage={sendMessage} modelOptions={modelOptions}
                projectName={projectDisplayName(chat.activeProject, t) || null}
                hasProject={Boolean(chat.activeProjectId)}
                onPickMaterials={() => setNewProjectOpen(true)}
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
    <NewProjectDialog
      open={newProjectOpen}
      onClose={() => setNewProjectOpen(false)}
      onCreate={createMaterialProject}
    />
    <ReplicateDialog
      item={pendingReplicate}
      onClose={() => setPendingReplicate(null)}
      onProceed={(guidance) => {
        const item = pendingReplicate;
        setPendingReplicate(null);
        if (item) startReplicate(item, guidance);
      }}
    />
  </div>
  </DownloadsProvider>;
}
