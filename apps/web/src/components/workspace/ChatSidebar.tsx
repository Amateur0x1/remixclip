'use client';

/**
 * [INPUT]: Projects, the conversations of the active project, the globally selected agent,
 *          search state and the running-state map.
 * [OUTPUT]: Left navigation content (macOS title bar, 对话 / 素材库 destination rows, project tree
 *           with the active project's chats nested inside it, search, agent/settings entry, language switcher).
 * [POS]: Navigation component shared by the fixed desktop sidebar and the narrow-screen drawer.
 *
 * Shape follows open-design: a conversation lives inside exactly one project, so the
 * projects are the tree roots and the active project's chats (plus "new chat") render nested
 * inside its row. The agent is NOT per project / per chat: one global entry sits at the bottom.
 */
import { Fragment, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { AgentInfo, Project } from '@remixclip/contracts';
import {
  Command,
  FolderClosed,
  Languages,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { SidebarThread } from '@/components/chat/chat-types';
import { LOCALES, LOCALE_LABEL, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { WorkspaceNav, type WorkspaceTab } from './WorkspaceNav';

export interface ChatSidebarProps {
  sidebarCompact: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  sidebarDrawerOpen: boolean;
  setSidebarDrawerOpen: (open: boolean) => void;
  sidebarToggleRef: RefObject<HTMLButtonElement>;
  sidebarSearchToggleRef: RefObject<HTMLButtonElement>;
  sidebarSearchOpen: boolean;
  setSidebarSearchOpen: (open: boolean) => void;
  sidebarQuery: string;
  setSidebarQuery: (query: string) => void;
  sidebarSearchTerms: string[];
  /** Workspace destination (chat / library) — the nav lives here, not in the chat header. */
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  /** Projects (containers) and the one currently open. */
  projects: Project[];
  projectsLoading: boolean;
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onNewProject: () => void;
  onRenameProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
  /** Globally connected agent (null = nothing connected yet). */
  agent: AgentInfo | null;
  agentId: string | null;
  agentsLoading: boolean;
  onOpenSettings: () => void;
  recentThreads: SidebarThread[];
  sidebarThreads: SidebarThread[];
  searchedThreads: SidebarThread[];
  showAllRecent: boolean;
  setShowAllRecent: Dispatch<SetStateAction<boolean>>;
  currentConvId: string | null;
  runningByConv: Record<string, { runId: string; startedAt: number }>;
  workflowError: string;
  startNewChat: () => void;
  selectSidebarThread: (thread: SidebarThread) => void;
  removeConversation: (id: string) => Promise<void>;
}

export function ChatSidebar({
  sidebarCompact,
  sidebarCollapsed,
  setSidebarCollapsed,
  sidebarDrawerOpen,
  setSidebarDrawerOpen,
  sidebarToggleRef,
  sidebarSearchToggleRef,
  sidebarSearchOpen,
  setSidebarSearchOpen,
  sidebarQuery,
  setSidebarQuery,
  sidebarSearchTerms,
  activeTab,
  onTabChange,
  projects,
  projectsLoading,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onRenameProject,
  onDeleteProject,
  agent,
  agentId,
  agentsLoading,
  onOpenSettings,
  recentThreads,
  sidebarThreads,
  searchedThreads,
  showAllRecent,
  setShowAllRecent,
  currentConvId,
  runningByConv,
  workflowError,
  startNewChat,
  selectSidebarThread,
  removeConversation,
}: ChatSidebarProps) {
  const { t, locale, setLocale } = useI18n();
  // Only the chat view owns the "current" highlight; in the library the nav row is current.
  const chatActive = activeTab === 'chat';
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const beginRename = (project: Project) => {
    setRenamingId(project.id);
    setRenameDraft(project.name);
  };
  const commitRename = () => {
    if (renamingId && renameDraft.trim()) onRenameProject(renamingId, renameDraft.trim());
    setRenamingId(null);
  };

  const renderSidebarThread = (thread: SidebarThread) => {
    const selected = chatActive && currentConvId !== null && thread.conversationId === currentConvId;
    const running = runningByConv[thread.conversation.id] !== undefined;
    return (
      <div key={thread.id} className={cn('group/thread relative flex min-w-0 items-center rounded-md transition-colors', selected ? 'glass-chosen' : 'hover:bg-secondary/70 focus-within:bg-secondary/70')}>
        <Tooltip delayDuration={400}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-current={selected ? 'page' : undefined}
              disabled={!thread.conversationId}
              className={cn(
                'flex h-9 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-[inherit] bg-transparent pr-2.5 pl-2.5 text-left text-[14px] text-foreground/85 transition-colors group-hover/thread:pr-9 group-focus-within/thread:pr-9 disabled:cursor-default disabled:opacity-50 [@media(hover:none)]:pr-9',
                selected ? 'font-medium text-foreground' : 'font-normal',
              )}
              onClick={() => selectSidebarThread(thread)}
            >
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              {running && (
                <span className="shrink-0 text-muted-foreground" role="status" aria-label={t('sidebar.running')}>
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                </span>
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" align="start" sideOffset={8} className="max-w-[min(24rem,calc(100vw-2rem))] whitespace-normal [overflow-wrap:anywhere]">
            {thread.title}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t('sidebar.threadActions', { title: thread.title })}
              className="pointer-events-none absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" sideOffset={6} className="w-40">
            <DropdownMenuItem disabled={running} onSelect={() => void removeConversation(thread.conversation.id)}>
              <Trash2 className="size-3.5" aria-hidden="true" />
              {t('sidebar.deleteChat')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  /**
   * The active project's chat group. "New chat" lives here (not in a global toolbar) because
   * a conversation can only be created inside a project — the row it sits under IS its owner.
   */
  const renderProjectChats = (project: Project) => (
    <div
      data-sidebar-project-chats={project.id}
      className="mt-0.5 mb-1 ml-3 space-y-0.5 border-l border-border/70 pl-1.5"
    >
      <button
        type="button"
        aria-label={t('sidebar.newChatInProject', { name: project.name })}
        className="flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-[14px] text-foreground/85 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary"
        onClick={startNewChat}
      >
        <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{t('common.newChat')}</span>
      </button>

      {sidebarSearchTerms.length > 0 ? (
        <div aria-label={t('sidebar.searchResultsAria')}>
          <h4 className="flex h-7 items-center px-2 text-[12px] font-normal text-muted-foreground">
            {t('sidebar.searchResults')}
          </h4>
          {searchedThreads.map((thread) => renderSidebarThread(thread))}
          <p role="status" className="px-2 py-1.5 text-[12.5px] text-muted-foreground">
            {searchedThreads.length > 0 ? t('sidebar.searchFound', { count: searchedThreads.length }) : t('sidebar.searchEmpty')}
          </p>
        </div>
      ) : (
        <>
          {recentThreads.map((thread) => renderSidebarThread(thread))}
          {recentThreads.length === 0 && (
            <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t('sidebar.recentEmpty')}</p>
          )}
          {sidebarThreads.length > 12 && (
            <button
              type="button"
              className="flex h-9 w-full items-center rounded-sm px-2.5 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:bg-secondary"
              onClick={() => setShowAllRecent((show) => !show)}
            >
              {showAllRecent ? t('sidebar.showLess') : t('sidebar.showMore')}
            </button>
          )}
        </>
      )}
    </div>
  );

  const renderProject = (project: Project) => {
    const active = project.id === activeProjectId;
    // Expanded follows the project, highlighted follows the view (library dims the tree).
    const highlighted = active && chatActive;
    if (renamingId === project.id) {
      return (
        <Fragment key={project.id}>
          <input
            autoFocus
            aria-label={t('sidebar.projectNameAria')}
            value={renameDraft}
            className="h-9 w-full rounded-sm bg-accent px-2.5 text-[14px] text-foreground outline-none"
            onChange={(event) => setRenameDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === 'Enter') { event.preventDefault(); commitRename(); }
              if (event.key === 'Escape') { event.preventDefault(); setRenamingId(null); }
            }}
          />
          {/* Renaming must not swallow the project's chats: only the row turns into an input. */}
          {active && renderProjectChats(project)}
        </Fragment>
      );
    }
    return (
      <Fragment key={project.id}>
        <div className={cn('group/project relative flex min-w-0 items-center rounded-md transition-colors', highlighted ? 'glass-chosen' : 'hover:bg-secondary/70 focus-within:bg-secondary/70')}>
          <button
            type="button"
            aria-current={highlighted ? 'true' : undefined}
            className={cn(
              'flex h-9 min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-[inherit] bg-transparent pr-2.5 pl-2.5 text-left text-[14px] transition-colors group-hover/project:pr-9 group-focus-within/project:pr-9 [@media(hover:none)]:pr-9',
              highlighted ? 'font-medium text-foreground' : 'font-normal text-foreground/85',
            )}
            onClick={() => onSelectProject(project.id)}
          >
            <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            {project.conversationCount ? (
              <span className="shrink-0 text-[11.5px] text-muted-foreground/70">{project.conversationCount}</span>
            ) : null}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('sidebar.projectActions', { name: project.name })}
                className="pointer-events-none absolute right-1 top-1/2 size-6 -translate-y-1/2 text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 data-[state=open]:pointer-events-auto data-[state=open]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
              >
                <MoreHorizontal className="size-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="right" sideOffset={6} className="w-40">
              <DropdownMenuItem onSelect={() => beginRename(project)}>{t('sidebar.renameProject')}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={projects.length <= 1}
                onSelect={() => {
                  if (window.confirm(t('sidebar.confirmDeleteProject', { name: project.name }))) onDeleteProject(project.id);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('sidebar.deleteProject')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {active && renderProjectChats(project)}
      </Fragment>
    );
  };

  const agentMissing = agent ? !agent.available : false;

  return (
    <>
      {/* This top row is the window title bar (46px on macOS Electron, horizontal centerline y = 23px):
          the traffic lights on the left (dots y=17..29, centerline y=23px) align with the icon column
          below; the "collapse sidebar" icon on the right aligns with the right edge of the shortcut below. */}
      <div data-remixclip-titlebar data-remixclip-sidebar-chrome className="flex h-12 shrink-0 items-center pr-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto size-7 text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label={sidebarCompact ? t('sidebar.close') : t('sidebar.collapse')}
              aria-controls="chat-sidebar"
              aria-expanded={sidebarCompact ? sidebarDrawerOpen : !sidebarCollapsed}
              onClick={() => {
                setSidebarDrawerOpen(false);
                if (!sidebarCompact) {
                  setSidebarCollapsed(true);
                  requestAnimationFrame(() => sidebarToggleRef.current?.focus());
                }
              }}
            >
              {sidebarCompact ? <X className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{sidebarCompact ? t('sidebar.close') : t('sidebar.collapse')}</TooltipContent>
        </Tooltip>
      </div>

      {/* Search: filters the active project's chats in place; the row turns into an input on click. */}
      <div className="flex shrink-0 flex-col gap-0.5 px-2">
        {sidebarSearchOpen ? (
          <label className="flex h-9 items-center gap-2 rounded-sm bg-accent px-2.5 text-[14px]">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              aria-label={t('sidebar.searchAria')}
              placeholder={t('sidebar.searchPlaceholder')}
              value={sidebarQuery}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
              onChange={(event) => setSidebarQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  setSidebarSearchOpen(false);
                  setSidebarQuery('');
                  sidebarSearchToggleRef.current?.focus();
                }
                if (event.key === 'Enter' && sidebarSearchTerms.length > 0) {
                  const thread = searchedThreads.find((item) => item.conversationId);
                  if (thread) {
                    event.preventDefault();
                    selectSidebarThread(thread);
                  }
                }
              }}
            />
            <button
              ref={sidebarSearchToggleRef}
              type="button"
              aria-label={t('sidebar.closeSearch')}
              className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground"
              onClick={() => {
                setSidebarSearchOpen(false);
                setSidebarQuery('');
              }}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </label>
        ) : (
          <button
            ref={sidebarSearchToggleRef}
            type="button"
            className="flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[14px] text-foreground/85 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary"
            onClick={() => {
              setSidebarSearchOpen(true);
              setSidebarQuery('');
            }}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t('sidebar.search')}</span>
            <span className="flex shrink-0 items-center gap-1" aria-hidden="true">
              <Kbd className="h-5 min-w-5 px-1"><Command className="size-3" /></Kbd>
              <Kbd className="h-5 min-w-5 px-1 text-[11px]">K</Kbd>
            </span>
          </button>
        )}
      </div>

      {/* Top-level destinations (对话 / 素材库) are sidebar controls; the main headers only carry titles. */}
      <div className="pt-1.5">
        <WorkspaceNav value={activeTab} onChange={onTabChange} />
      </div>

      {/* Radix's table content container gets widened by long names; use block so truncation fits the sidebar width. */}
      <ScrollArea className="min-h-0 min-w-0 flex-1 [&>[data-slot=scroll-area-viewport]>div]:block!">
        <div className="w-full min-w-0 px-2 pt-2 pb-5">
          {workflowError && <p role="alert" className="mx-0.5 mb-2 rounded-sm bg-secondary p-2 text-[12.5px] text-foreground">{workflowError}</p>}
          <section aria-label={t('sidebar.projectsAria')} className="min-w-0">
            <div className="flex h-7 items-center justify-between pr-1 pl-2.5">
              <h3 className="text-[12px] font-normal text-muted-foreground">{t('sidebar.projects')}</h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="size-6 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    aria-label={t('sidebar.newProject')}
                    onClick={onNewProject}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{t('sidebar.newProject')}</TooltipContent>
              </Tooltip>
            </div>
            {projectsLoading && projects.length === 0 ? (
              <div className="mt-0.5 flex items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-2 text-[12.5px] text-muted-foreground">
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                {t('sidebar.projectsLoading')}
              </div>
            ) : (
              projects.map((project) => renderProject(project))
            )}
          </section>
        </div>
      </ScrollArea>

      {/* Global agent: one pill at the bottom, click opens settings (detect / switch / test).
          The agent is app-wide, not per project — same as open-design. */}
      <div className="shrink-0 px-2">
        <button
          type="button"
          aria-label={t('sidebar.agentSettingsAria')}
          className="flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] text-foreground/85 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary"
          onClick={onOpenSettings}
        >
          {agentsLoading ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : agentId ? (
            <AgentIcon id={agentId} size={16} className={cn('shrink-0', agentMissing && 'opacity-40 grayscale')} />
          ) : (
            <Settings2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {agentsLoading ? t('sidebar.detecting') : (agent?.name ?? (agentId || t('sidebar.connectAgent')))}
          </span>
          <span className={cn('size-1.5 shrink-0 rounded-full', agent && agent.available && !agentMissing ? 'bg-status-done' : 'bg-status-interrupted')} aria-hidden="true" />
        </button>
      </div>

      {/*
        Language switcher: pinned to the sidebar bottom (same slot as the agent pill), does not
        scroll with the recent list. The current language shows its native name via LOCALE_LABEL —
        language names are never translated, else after switching to a wrong language the user
        couldn't figure out how to switch back.
      */}
      <div className="shrink-0 px-2 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('locale.switcherAria')}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] text-muted-foreground outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:bg-secondary"
            >
              <Languages className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{t('locale.label')}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground/80">{LOCALE_LABEL[locale]}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-40">
            <DropdownMenuRadioGroup
              value={locale}
              onValueChange={(next) => {
                const picked = LOCALES.find((item) => item === next);
                if (picked) setLocale(picked);
              }}
            >
              {LOCALES.map((item) => (
                <DropdownMenuRadioItem key={item} value={item}>
                  {LOCALE_LABEL[item]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
