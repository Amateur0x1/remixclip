'use client';

/**
 * [INPUT]: Current session message stream, LiveTurn state, reconnect state and attachment state.
 * [OUTPUT]: Chat main column (window header, empty-state guidance, scrolling message stream, back-to-bottom button and Composer input).
 * [POS]: Main panel component of the chat workspace.
 */
import type { Dispatch, RefObject, SetStateAction, UIEvent, WheelEvent } from 'react';
import type { AgentInfo, ChatAttachment } from '@remixclip/contracts';
import {
  ArrowBigUp,
  ArrowDown,
  CornerDownLeft,
  LoaderCircle,
  PanelLeftOpen,
  Plus,
  Radar,
  X,
} from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Composer, ComposerFooter, ComposerFooterEnd, ComposerPick } from '@/components/ui/composer';
import { Kbd } from '@/components/ui/kbd';
import { Tag } from '@/components/ui/tag';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TurnStatus } from '@/components/ui/turn-status';
import { Reconnect } from '@/components/chat/Reconnect';
import { MessageView, TurnItems } from '@/components/chat/MessageView';
import {
  artifactIcon,
  formatSize,
  styles,
  type LiveTurn,
  type PendingAttachment,
  type UiMessage,
} from '@/components/chat/chat-types';
import type { ChatReconnectView } from '@/runtime/chat/reconnect-state';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

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
  /** The globally connected agent (empty = nothing connected yet). */
  agent: AgentInfo | null;
  agentId: string | null;
  agentsLoading: boolean;
  onOpenSettings: () => void;
  /** Name of the project the open conversation belongs to. */
  projectName: string | null;
  startNewChat: () => void;
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
  agent,
  agentId,
  agentsLoading,
  onOpenSettings,
  projectName,
  startNewChat,
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

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col">
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
        </div>
      </header>

      {!currentConvId ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <img className="mb-4 block size-12 rounded-xl shadow-sm" src="/remixclip-logo.svg" alt="" width="48" height="48" />
          {agentId ? (
            <>
              <h2 className="text-xl font-semibold tracking-tight text-foreground">{t('chat.emptyTitle')}</h2>
              <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {t('chat.emptyProjectLine', {
                  project: projectName ?? t('sidebar.untitledProject'),
                  agent: agent?.name ?? agentId,
                  model: model || t('chat.modelAuto'),
                })}
              </p>
              <Button type="button" className="mt-5 gap-1.5" onClick={startNewChat}>
                <Plus className="size-4" aria-hidden="true" />
                {t('common.newChat')}
              </Button>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      ) : (
        <>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              className="flex min-h-0 flex-1 justify-center overflow-y-auto px-4 pt-5 pb-6 [scrollbar-width:thin] md:px-6"
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
                    {turn.error && <div className={styles.execError}>❌ {turn.error}</div>}
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
              {/* Writing surface is layered apart from "how it gets sent": body sits in the glass, model and other settings live in the footer. */}
              <Composer
                className="border border-border shadow-md"
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
                placeholder={isRunning ? t('chat.placeholderRunning') : t('chat.placeholderIdle')}
                textareaRef={inputRef}
                textareaProps={{ 'aria-label': t('chat.messageAria') }}
              />
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
  );
}
