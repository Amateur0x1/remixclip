'use client';

/**
 * [INPUT]: Current session message stream, LiveTurn state, reconnect state and attachment state.
 * [OUTPUT]: Chat main column (window header, the "what do you want to create" home hero before
 *           any chat is open, scrolling message stream, back-to-bottom button and Composer input).
 * [POS]: Main panel component of the chat workspace.
 */
import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction, type UIEvent, type WheelEvent } from 'react';
import type { AgentInfo, ChatAttachment } from '@remixclip/contracts';
import {
  ArrowBigUp,
  ArrowDown,
  ChevronDown,
  Coins,
  CornerDownLeft,
  FileText,
  Film,
  FolderOpen,
  Image as ImageIcon,
  LoaderCircle,
  PanelLeftOpen,
  Plus,
  Presentation,
  Radar,
  Shapes,
  Video,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Composer, ComposerFooter, ComposerFooterEnd, ComposerPick } from '@/components/ui/composer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Tag } from '@/components/ui/tag';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TurnStatus } from '@/components/ui/turn-status';
import { Reconnect } from '@/components/chat/Reconnect';
import { RunErrorNotice } from '@/components/chat/RunErrorNotice';
import { MessageView, TurnItems } from '@/components/chat/MessageView';
import { ArtifactPanel } from '@/components/chat/ArtifactPanel';
import { ArtifactPreviewDialog } from '@/components/chat/ArtifactPreviewDialog';
import { DownloadsButton } from '@/components/library/DownloadsCenter';
import {
  artifactIcon,
  formatSize,
  styles,
  type ArtifactTarget,
  type LiveTurn,
  type PendingAttachment,
  type UiMessage,
} from '@/components/chat/chat-types';
import type { ChatReconnectView } from '@/runtime/chat/reconnect-state';
import { useI18n, type DictKey } from '@/i18n';
import { cn } from '@/lib/utils';

const ARTIFACT_PANEL_STORAGE_KEY = 'remixclip:artifacts-panel';

/**
 * Starter lanes under the home composer. Each one is only a brief in the making: the chip writes
 * an opening line into the body and leaves the cursor there, so the blank page never stays blank
 * for long. Kept as data so the row and the "more" menu share one shape.
 */
const HOME_CHIPS: { id: string; labelKey: DictKey; promptKey: DictKey; icon: LucideIcon }[] = [
  { id: 'prototype', labelKey: 'home.chipPrototype', promptKey: 'home.promptPrototype', icon: Shapes },
  { id: 'motion', labelKey: 'home.chipMotion', promptKey: 'home.promptMotion', icon: Film },
  { id: 'deck', labelKey: 'home.chipDeck', promptKey: 'home.promptDeck', icon: Presentation },
];

const HOME_MORE_CHIPS: { id: string; labelKey: DictKey; promptKey: DictKey; icon: LucideIcon }[] = [
  { id: 'document', labelKey: 'home.chipDocument', promptKey: 'home.promptDocument', icon: FileText },
  { id: 'image', labelKey: 'home.chipImage', promptKey: 'home.promptImage', icon: ImageIcon },
  { id: 'video', labelKey: 'home.chipVideo', promptKey: 'home.promptVideo', icon: Video },
];

export interface ChatConversationPaneProps {
  sidebarCollapsed: boolean;
  sidebarCompact: boolean;
  sidebarDrawerOpen: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarDrawerOpen: (open: boolean) => void;
  sidebarToggleRef: RefObject<HTMLButtonElement>;
  sidebarSearchToggleRef: RefObject<HTMLButtonElement>;
  currentThreadTitle: string;
  currentConvId: string | null;
  loadedConversationId: string | null;
  /** History is being fetched and neither a cache nor a real log can be shown yet. */
  historyLoading: boolean;
  projectsLoading: boolean;
  /** The globally connected agent (empty = nothing connected yet). */
  agent: AgentInfo | null;
  agentId: string | null;
  agentsLoading: boolean;
  onOpenSettings: () => void;
  /** Name of the project the open conversation belongs to. */
  projectName: string | null;
  /** False = no project yet, so there is no working directory (and no reference) to chat about. */
  hasProject: boolean;
  /** Opens the new-project dialog: material first, then a chat. */
  onPickMaterials: () => void;
  scrollRef: RefObject<HTMLDivElement>;
  handleScroll: (event: UIEvent<HTMLDivElement>) => void;
  handleWheel: (event: WheelEvent<HTMLDivElement>) => void;
  messages: UiMessage[];
  isRunning: boolean;
  turn: LiveTurn;
  reconnectView: ChatReconnectView | null;
  handleManualReconnect: () => void;
  stopRun: () => Promise<void>;
  jumpShown: boolean;
  resetFollow: () => void;
  workflowError: string;
  queued: { text: string; key: string; preserveDraft?: boolean; attachments?: ChatAttachment[] }[];
  setQueued: Dispatch<SetStateAction<{ text: string; key: string; preserveDraft?: boolean; attachments?: ChatAttachment[] }[]>>;
  currentKey: string;
  inputText: string;
  setInputText: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement>;
  fileInputRef: RefObject<HTMLInputElement>;
  pendingAttachments: PendingAttachment[];
  armedAttachmentId: string | null;
  setArmedAttachmentId: (id: string | null) => void;
  handleAttachFiles: (files: File[]) => void;
  removePendingAttachment: (clientId: string) => void;
  setLightboxImage: (img: { url: string; name: string } | null) => void;
  sendMessage: () => void;
  model: string;
  setModel: (model: string) => void;
  modelOptions: { value: string; label: string }[];
}

export function ChatConversationPane({
  sidebarCollapsed,
  sidebarCompact,
  sidebarDrawerOpen,
  setSidebarCollapsed,
  setSidebarDrawerOpen,
  sidebarToggleRef,
  sidebarSearchToggleRef,
  currentThreadTitle,
  currentConvId,
  loadedConversationId,
  historyLoading,
  projectsLoading,
  agent,
  agentId,
  agentsLoading,
  onOpenSettings,
  projectName,
  hasProject,
  onPickMaterials,
  scrollRef,
  handleScroll,
  handleWheel,
  messages,
  isRunning,
  turn,
  reconnectView,
  handleManualReconnect,
  stopRun,
  jumpShown,
  resetFollow,
  workflowError,
  queued,
  setQueued,
  currentKey,
  inputText,
  setInputText,
  inputRef,
  fileInputRef,
  pendingAttachments,
  armedAttachmentId,
  setArmedAttachmentId,
  handleAttachFiles,
  removePendingAttachment,
  setLightboxImage,
  sendMessage,
  model,
  setModel,
  modelOptions,
}: ChatConversationPaneProps) {
  const { t } = useI18n();
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [artifactTarget, setArtifactTarget] = useState<ArtifactTarget | null>(null);
  const storedPanelState = useRef(false);

  // Read after mount so SSR and the first client paint agree; then persist every explicit toggle.
  useEffect(() => {
    try {
      setArtifactsOpen(window.localStorage.getItem(ARTIFACT_PANEL_STORAGE_KEY) === '1');
    } catch {
      // Private mode / storage disabled: keep the in-memory default.
    }
  }, []);
  useEffect(() => {
    if (!storedPanelState.current) {
      storedPanelState.current = true;
      return;
    }
    try {
      window.localStorage.setItem(ARTIFACT_PANEL_STORAGE_KEY, artifactsOpen ? '1' : '0');
    } catch {
      // Persisting the panel width is a nicety, never a requirement.
    }
  }, [artifactsOpen]);

  /**
   * The writing surface, built once for two very different frames: the docked composer under a
   * conversation and the big card on the home hero. Only the frame and the placeholder differ —
   * IME handling, Enter-to-send, paste and drag-and-drop must behave identically in both.
   */
  const composer = (hero: boolean) => (
    <Composer
      className={hero ? 'rounded-none bg-transparent px-3 py-3' : 'border border-border shadow-md'}
      value={inputText}
      onValueChange={(val) => {
        setInputText(val);
        setArmedAttachmentId(null);
      }}
      onSubmit={() => sendMessage()}
      onStop={() => void stopRun()}
      running={isRunning}
      disabled={Boolean(currentConvId && loadedConversationId !== currentConvId)}
      canSubmit={Boolean(
        (inputText.trim() || pendingAttachments.some((item) => item.uploaded && !item.error)) &&
          !pendingAttachments.some((item) => item.uploading || item.error || !item.uploaded) &&
          !(currentConvId && loadedConversationId !== currentConvId),
      )}
      onAttachFiles={handleAttachFiles}
      onBackspaceAtStart={() => {
        if (pendingAttachments.length === 0) return false;
        const last = pendingAttachments[pendingAttachments.length - 1]!;
        if (armedAttachmentId !== last.clientId) {
          setArmedAttachmentId(last.clientId);
        } else {
          removePendingAttachment(last.clientId);
        }
        return true;
      }}
      above={
        pendingAttachments.some((item) => item.mimeType.startsWith('image/')) ? (
          <>
            {pendingAttachments
              .filter((item) => item.mimeType.startsWith('image/'))
              .map((item) => {
                const imgSrc = item.previewUrl ?? item.uploaded?.url;
                return (
                  <div
                    key={item.clientId}
                    title={item.error ?? `${item.name} (${formatSize(item.size)})`}
                    className={cn(
                      'group/thumb relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-muted/40 transition-all',
                      item.error && 'border-destructive ring-1 ring-destructive/40',
                      armedAttachmentId === item.clientId && 'ring-2 ring-ring',
                    )}
                  >
                    {imgSrc && (
                      <img
                        src={imgSrc}
                        alt={item.name}
                        onClick={() => setLightboxImage({ url: imgSrc, name: item.name })}
                        className="size-full cursor-zoom-in object-cover"
                      />
                    )}
                    {item.uploading && (
                      <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
                        <LoaderCircle className="size-4 animate-spin text-foreground" aria-hidden="true" />
                      </div>
                    )}
                    <button
                      type="button"
                      aria-label={t('chat.removeAttachment', { name: item.name })}
                      onClick={() => removePendingAttachment(item.clientId)}
                      className="absolute top-1 right-1 flex size-4.5 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-xs backdrop-blur-xs transition-colors hover:bg-background hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
          </>
        ) : undefined
      }
      leading={
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length > 0) handleAttachFiles(files);
              event.target.value = '';
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('chat.attach')}
                disabled={Boolean(currentConvId && loadedConversationId !== currentConvId)}
                onClick={() => fileInputRef.current?.click()}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('chat.attachHint')}</TooltipContent>
          </Tooltip>
        </>
      }
      tags={
        pendingAttachments.some((item) => !item.mimeType.startsWith('image/')) ? (
          <>
            {pendingAttachments
              .filter((item) => !item.mimeType.startsWith('image/'))
              .map((item) => {
                const FileIcon = artifactIcon(item.name);
                return (
                  <Tag
                    key={item.clientId}
                    className="mb-0.5"
                    icon={<FileIcon />}
                    progress={item.uploading ? 0.5 : undefined}
                    error={item.error}
                    armed={armedAttachmentId === item.clientId}
                    onRemove={() => removePendingAttachment(item.clientId)}
                  >
                    {item.name}
                  </Tag>
                );
              })}
          </>
        ) : undefined
      }
      trailing={
        hero ? (
          <ComposerPick
            label={t('chat.model')}
            value={model}
            options={modelOptions}
            onValueChange={setModel}
            disabled={isRunning}
          />
        ) : undefined
      }
      placeholder={hero ? t('home.placeholder') : isRunning ? t('chat.placeholderRunning') : t('chat.placeholderIdle')}
      textareaClassName={hero ? 'min-h-[84px] text-[14.5px] leading-7' : undefined}
      textareaRef={inputRef}
      textareaProps={{ 'aria-label': t('chat.messageAria') }}
    />
  );

  /** A chip only writes the opening line — the cursor lands after the colon so the user keeps going. */
  const writeHeroPrompt = (prompt: string) => {
    setInputText(prompt);
    setArmedAttachmentId(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(prompt.length, prompt.length);
    });
  };

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
      {/* Two columns, each with its own header: the conversation strip and the file strip share
          one top line, and the vertical border keeps them separate all the way down. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-remixclip-titlebar
        data-remixclip-sidebar-chrome={sidebarCollapsed || sidebarCompact ? '' : undefined}
        className="@container/chat-header flex h-12 min-w-0 shrink-0 items-center gap-1.5 px-3"
      >
        {(sidebarCollapsed || sidebarCompact) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                ref={sidebarToggleRef}
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('sidebar.open')}
                aria-controls="chat-sidebar"
                aria-expanded={sidebarCompact ? sidebarDrawerOpen : !sidebarCollapsed}
                className="size-7 text-muted-foreground hover:bg-secondary hover:text-foreground"
                onClick={() => {
                  if (sidebarCompact) setSidebarDrawerOpen(true);
                  else {
                    setSidebarCollapsed(false);
                    requestAnimationFrame(() => sidebarSearchToggleRef.current?.focus());
                  }
                }}
              >
                <PanelLeftOpen className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('sidebar.open')}</TooltipContent>
          </Tooltip>
        )}
        <h3 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-foreground" title={currentThreadTitle}>
          {currentThreadTitle}
        </h3>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {currentConvId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn(
                    'size-7 text-muted-foreground hover:bg-secondary hover:text-foreground',
                    artifactsOpen && 'bg-secondary text-foreground',
                  )}
                  aria-label={t('artifacts.toggle')}
                  aria-pressed={artifactsOpen}
                  aria-controls={artifactsOpen ? 'artifact-panel' : undefined}
                  onClick={() => setArtifactsOpen((open) => !open)}
                >
                  <FolderOpen className="size-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('artifacts.toggle')}</TooltipContent>
            </Tooltip>
          )}
          {agentId && (() => {
            const missing = agent ? !agent.available : false;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="flex items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    onClick={onOpenSettings}
                    aria-label={t('chat.switchAgent')}
                  >
                    <AgentIcon id={agentId} size={14} className={missing ? 'opacity-40 grayscale' : undefined} />
                    <span className="max-w-[10rem] truncate">{agent?.name ?? agentId}</span>
                    {missing && <span className="size-1.5 rounded-full bg-status-interrupted" aria-label={t('sidebar.agentMissing')} />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" align="end">
                  {agent ? `${agent.name}${agent.version ? ` · ${agent.version}` : ''}` : agentId}
                  {missing ? t('sidebar.missingSuffix') : ''}
                  <span className="mt-0.5 block text-[11.5px] opacity-70">{t('chat.switchHint')}</span>
                </TooltipContent>
              </Tooltip>
            );
          })()}
          {/* Downloads run in the daemon, so the indicator stays useful outside the library tab. */}
          <DownloadsButton />
        </div>
      </header>

      {historyLoading || (projectsLoading && !hasProject) ? (
        /* Quiet loading state: never the 48px logo here. A local history round-trip can finish in
           a few frames, and the logo flashing in between is what made every switch look glitchy. */
        <div role="status" aria-live="polite" className="flex min-h-0 flex-1 items-center justify-center">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground/60" aria-hidden="true" />
          <span className="sr-only">{t('chat.loadingHistory')}</span>
        </div>
      ) : !currentConvId && !hasProject ? (
        /* A project is founded from material: with none, the only honest next step is the picker.
           Chatting first would have no working directory and no `reference/` to read. */
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-center">
          <div className="w-full max-w-[460px]">
            <img className="mx-auto mb-4 block size-12 rounded-xl shadow-sm" src="/remixclip-logo.svg" alt="" width="48" height="48" />
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{t('sidebar.newProject')}</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('home.pickMaterialsDesc')}</p>
            <Button type="button" className="mt-5 gap-1.5" onClick={onPickMaterials}>
              <Plus className="size-4" aria-hidden="true" />
              {t('home.pickMaterials')}
            </Button>
          </div>
        </div>
      ) : !currentConvId ? (
        agentId ? (
          /* The first screen: nothing is open yet, so the page offers one wide writing surface
             instead of a chat log. Chips write the opening line; the working folder sits under it
             because the project's directory is the only context a first message carries. */
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
            <div className="w-full max-w-[680px]">
              <h2 className="text-center text-[26px] leading-tight font-semibold tracking-tight text-foreground">{t('home.title')}</h2>
              <p className="mt-2 text-center text-[13px] text-muted-foreground">{t('home.subtitle')}</p>

              <div className="mt-7">
                {workflowError && <div role="alert" className={styles.pathError}>{workflowError}</div>}
                <div className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_18px_48px_-28px_rgba(15,23,42,0.45)] transition-colors focus-within:border-ring/60">
                  {composer(true)}
                  <div
                    title={t('home.workingDirHint')}
                    className="flex items-center gap-1.5 border-t border-border/60 bg-muted/40 px-3.5 py-2 text-[12px] text-muted-foreground"
                  >
                    <FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="shrink-0">{t('home.workingDir')}</span>
                    <span className="min-w-0 truncate text-foreground/75">{projectName ?? t('sidebar.untitledProject')}</span>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
                  {HOME_CHIPS.map((chip) => (
                    <Button
                      key={chip.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-full bg-card font-normal text-foreground/80"
                      onClick={() => writeHeroPrompt(t(chip.promptKey))}
                    >
                      <chip.icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      {t(chip.labelKey)}
                    </Button>
                  ))}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={t('home.chipMore')}
                        className="rounded-full bg-card font-normal text-foreground/80"
                      >
                        {t('home.chipMore')}
                        <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="center" className="min-w-36">
                      {HOME_MORE_CHIPS.map((chip) => (
                        <DropdownMenuItem
                          key={chip.id}
                          className="text-[13px]"
                          onSelect={() => writeHeroPrompt(t(chip.promptKey))}
                        >
                          <chip.icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          {t(chip.labelKey)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
            <img className="mb-4 block size-12 rounded-xl shadow-sm" src="/remixclip-logo.svg" alt="" width="48" height="48" />
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {agentsLoading ? t('sidebar.detecting') : t('chat.emptyPickAgent')}
            </h2>
            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              {t('chat.emptyPickAgentDesc')}
            </p>
            <Button type="button" className="mt-5 gap-1.5" disabled={agentsLoading} onClick={onOpenSettings}>
              {agentsLoading ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <Radar className="size-4" aria-hidden="true" />}
              {agentsLoading ? t('chat.detectingButton') : t('sidebar.connectAgent')}
            </Button>
          </div>
        )
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pt-5 pb-6 scrollbar-thin md:px-6"
              ref={scrollRef}
              onScroll={handleScroll}
              onWheel={handleWheel}
            >
              <div className="flex h-fit w-full max-w-[600px] flex-col">
                {messages.length === 0 && !isRunning && (
                  <div className="pt-24 text-center text-muted-foreground">
                    <img className="mx-auto mb-4 block size-12 rounded-xl shadow-sm" src="/remixclip-logo.svg" alt="" width="48" height="48" />
                    <h2 className="text-2xl font-semibold tracking-tight text-foreground">{t('chat.blankTitle')}</h2>
                    <p className="mt-2 text-sm">{t('chat.blankDesc')}</p>
                  </div>
                )}

                {messages.map((msg) => (
                  <MessageView key={msg.id} msg={msg} />
                ))}

                {/* In-flight turn (execution shell, aligned with the open-design shell model) */}
                {isRunning && (
                  <div className="mb-5 max-w-[800px]">
                    {turn.stopped ? (
                      <TurnStatus className="px-0.5 py-1.5" active={false} label={t('chat.stopped')} />
                    ) : (
                      <TurnStatus
                        className="px-0.5 py-1.5"
                        label={turn.thinking ? t('chat.thinking') : turn.statusLabel || t('chat.running')}
                        since={turn.startedAt || undefined}
                      />
                    )}
                    <TurnItems items={turn.items} toolCalls={turn.toolCalls} streaming />
                    {turn.error && <RunErrorNotice error={turn.error} />}
                  </div>
                )}

                {/* Stream tail: reconnect row. The whole row disappears once recovered; when attempts run
                    out it turns into [Reconnect] and hands control back to the user (22-3). */}
                {reconnectView && (
                  <Reconnect
                    attempt={reconnectView.attempt}
                    max={reconnectView.max}
                    reason={reconnectView.reason}
                    exhausted={reconnectView.exhausted}
                    onReconnect={handleManualReconnect}
                  />
                )}
              </div>
            </div>
          </div>

          {jumpShown && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="absolute bottom-[108px] left-1/2 z-10 -translate-x-1/2 rounded-full bg-card text-foreground shadow-md"
              onClick={() => {
                // "Jump to latest" is an explicit action: reset intent back to following, same path as sending a message or switching sessions
                resetFollow();
                const el = scrollRef.current;
                if (el) el.scrollTop = el.scrollHeight;
              }}
            >
              <ArrowDown className="size-4" aria-hidden="true" />{t('chat.jumpToBottom')}
            </Button>
          )}

          {/* The input area no longer slices itself off with border-top: it's a floating white rounded card that hovers above the messages via shadow. */}
          <div className="flex shrink-0 justify-center px-4 pb-4 md:px-6">
            <div className="w-full max-w-[600px]">
              {workflowError && <div role="alert" className={styles.pathError}>{workflowError}</div>}
              {queued.some((item) => item.key === currentKey) && (
                <div className={styles.queueHint} role="status">
                  {t('chat.queueHint', { count: queued.filter((item) => item.key === currentKey).length })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="ml-auto text-muted-foreground"
                    onClick={() => setQueued((items) => items.filter((item) => item.key !== currentKey))}
                  >
                    {t('common.clear')}
                  </Button>
                </div>
              )}
              {/* Quota is a precondition for sending, not a surprise to discover after the turn fails:
                  if the last real run reported an exhaustion, say so above the input. */}
              {agent?.quota?.status === 'exhausted' && (
                <div
                  role="status"
                  className="mb-2 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[11.5px] leading-5 text-amber-700 dark:text-amber-300"
                >
                  <Coins className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    {agent.quota.detail?.trim() || t('settings.quotaExhausted')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="-mr-1 shrink-0 text-amber-700 hover:bg-amber-500/10 hover:text-amber-800 dark:text-amber-300"
                    onClick={onOpenSettings}
                  >
                    {t('settings.quotaOpenSettings')}
                  </Button>
                </div>
              )}
              {/* Writing surface is layered apart from "how it gets sent": body sits in the glass, model and other settings live in the footer. */}
              {composer(false)}
              <ComposerFooter>
                <span className="hidden items-center gap-1 text-[11.5px] text-muted-foreground/80 min-[520px]:flex">
                  <Kbd className="h-5 min-w-5 px-1"><CornerDownLeft className="size-3" aria-hidden="true" /></Kbd>
                  {t('chat.send')}
                  <Kbd className="h-5 min-w-5 gap-0.5 px-1"><ArrowBigUp className="size-3" aria-hidden="true" /><CornerDownLeft className="size-3" aria-hidden="true" /></Kbd>
                  {t('chat.newline')}
                </span>
                <ComposerFooterEnd>
                  <ComposerPick
                    label={t('chat.model')}
                    value={model}
                    options={modelOptions}
                    onValueChange={setModel}
                    disabled={isRunning}
                  />
                </ComposerFooterEnd>
              </ComposerFooter>
            </div>
          </div>
        </>
      )}
        </div>
        {currentConvId && artifactsOpen && (
            <ArtifactPanel
              conversationId={currentConvId}
              running={isRunning}
              onOpen={setArtifactTarget}
              onClose={() => setArtifactsOpen(false)}
            />
        )}
      </div>
      <ArtifactPreviewDialog target={artifactTarget} onClose={() => setArtifactTarget(null)} />
    </div>
  );
}
