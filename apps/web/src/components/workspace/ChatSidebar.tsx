'use client';

/**
 * [INPUT]: Projects (each project IS one chat), the globally selected agent, search state and the
 *          running state of the active project.
 * [OUTPUT]: Left navigation content (macOS title bar, 对话 / 素材库 destination rows, project list,
 *           search, and a single settings entry).
 * [POS]: Navigation component shared by the fixed desktop sidebar and the narrow-screen drawer.
 *
 * Shape follows the 1:1 model: a project owns exactly one conversation, so the project rows ARE
 * the chat rows — there is no nested thread list and no "new chat inside a project" action.
 * Starting a new chat means creating a new project (the + in the projects header).
 */
import { useState, type RefObject } from 'react';
import type { AgentInfo, Project } from '@remixclip/contracts';
import {
  Command,
  FolderClosed,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/i18n';
import { projectDisplayName } from '@/lib/project-name';
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
  /** Workspace destination (chat / library / cuts) — the nav lives here, not in the chat header. */
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
  /** The settings page owns the main pane right now, so the bottom entry reads as current. */
  settingsOpen: boolean;
  /** Project whose chat is running right now (1:1: the project row carries the spinner). */
  runningProjectId: string | null;
  workflowError: string;
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
  settingsOpen,
  runningProjectId,
  workflowError,
}: ChatSidebarProps) {
  const { t } = useI18n();
  // Only the chat view owns the "current" highlight; in the library the nav row is current.
  const chatActive = activeTab === 'chat';
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const beginRename = (project: Project) => {
    setRenamingId(project.id);
    setRenameDraft(projectDisplayName(project, t));
  };
  const commitRename = () => {
    if (renamingId && renameDraft.trim()) onRenameProject(renamingId, renameDraft.trim());
    setRenamingId(null);
  };

  // Search filters the projects themselves: with one chat per project, the project name is the
  // only chat title there is.
  const visibleProjects =
    sidebarSearchTerms.length === 0
      ? projects
      : projects.filter((project) => {
          const name = projectDisplayName(project, t).toLocaleLowerCase();
          return sidebarSearchTerms.every((term) => name.includes(term));
        });

  const renderProject = (project: Project) => {
    const highlighted = project.id === activeProjectId && chatActive;
    const running = runningProjectId === project.id;
    if (renamingId === project.id) {
      return (
        <input
          key={project.id}
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
      );
    }
    return (
      <div
        key={project.id}
        className={cn('group/project relative flex min-w-0 items-center rounded-md transition-colors', highlighted ? 'glass-chosen' : 'hover:bg-secondary/70 focus-within:bg-secondary/70')}
      >
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
          <span className="min-w-0 flex-1 truncate">{projectDisplayName(project, t)}</span>
          {running && (
            <span className="shrink-0 text-muted-foreground" role="status" aria-label={t('sidebar.running')}>
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            </span>
          )}
        </button>
        {/* One action per project row: manage it. Starting a chat is starting a project. */}
        <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-hover/project:pointer-events-auto group-hover/project:opacity-100 group-focus-within/project:pointer-events-auto group-focus-within/project:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('sidebar.projectActions', { name: projectDisplayName(project, t) })}
                className="size-6 text-muted-foreground hover:bg-secondary hover:text-foreground"
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
                  if (window.confirm(t('sidebar.confirmDeleteProject', { name: projectDisplayName(project, t) }))) onDeleteProject(project.id);
                }}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('sidebar.deleteProject')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
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
                  const project = visibleProjects[0];
                  if (project) {
                    event.preventDefault();
                    onSelectProject(project.id);
                    setSidebarSearchOpen(false);
                    setSidebarQuery('');
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
            ) : visibleProjects.length === 0 ? (
              <p role="status" className="px-2.5 py-1.5 text-[12.5px] text-muted-foreground">
                {t('sidebar.searchEmpty')}
              </p>
            ) : (
              visibleProjects.map((project) => renderProject(project))
            )}
          </section>
        </div>
      </ScrollArea>

      {/*
        One entry at the bottom: the drawer it opens owns agent management, the companion download,
        and the language switcher. The trailing agent name + dot keep "who runs my chats" visible
        without a second row, and nothing here scrolls with the recent list.
      */}
      <div className="shrink-0 px-2 pb-2">
        <button
          type="button"
          aria-label={t('sidebar.settingsAria')}
          aria-current={settingsOpen ? 'page' : undefined}
          className={cn(
            'flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[13px] outline-none transition-colors hover:bg-secondary hover:text-foreground focus-visible:bg-secondary',
            settingsOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground',
          )}
          onClick={onOpenSettings}
        >
          <Settings className="size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{t('settings.title')}</span>
          {agentsLoading ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          ) : agentId ? (
            <span className="flex min-w-0 max-w-[50%] items-center gap-1.5 text-[11.5px]">
              <span className="truncate">{agent?.name ?? agentId}</span>
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  agent && agent.available && !agentMissing ? 'bg-status-done' : 'bg-status-interrupted',
                )}
                aria-hidden="true"
              />
            </span>
          ) : null}
        </button>
      </div>
    </>
  );
}
