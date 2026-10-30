'use client';

/**
 * [INPUT]: UiMessage (with user image/file attachments, assistant turnItems, toolCalls, artifacts).
 * [OUTPUT]: Message bubbles, attachment thumbnails and preview dialog, interleaved tool tree (ToolTree / TurnItems), thinking and the turn's artifact list.
 * [POS]: Core renderer for a single message in the conversation stream and for an in-progress Turn.
 */
import { useMemo, useState } from 'react';
import type { RunArtifact } from '@remixclip/contracts';
import {
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleX,
  Copy,
  Folder,
  LoaderCircle,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tag } from '@/components/ui/tag';
import { formatShellElapsed } from '@/runtime/chat/format';
import { toolKind, toolTitle } from '@/runtime/chat/tool-kind';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './MarkdownContent';
import {
  KIND_ICON,
  artifactIcon,
  formatSize,
  formatTime,
  styles,
  summarizeInput,
  type ToolCall,
  type TurnItem,
  type UiMessage,
} from './chat-types';

export function MessageView({ msg }: { msg: UiMessage }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [previewImg, setPreviewImg] = useState<{ url: string; name: string } | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // When the clipboard is unavailable, leave the text as is; the user can still select and copy manually.
    }
  };
  const copyButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 shrink-0 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover/msg:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      onClick={() => void copy()}
      aria-label={t('message.copyReply')}
    >
      {copied ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
    </Button>
  );

  // assistant messages carry a timeline: replay tools/thinking/text interleaved (open-design turn blocks)
  if (msg.role === 'assistant' && msg.turnItems?.length) {
    return (
      <div className="group/msg mb-6 w-full max-w-[820px]">
        <TurnItems items={msg.turnItems} toolCalls={msg.toolCalls ?? []} />
        {msg.error && <div role="alert" className={styles.execError}>{msg.error}</div>}
        <ArtifactList msg={msg} />
        <div className={cn(styles.messageTime, 'flex items-center gap-2')}>
          {msg.stopped && <span className={styles.shellStopped}>{t('message.stoppedPrefix')}</span>}
          {formatShellElapsed(msg.elapsedMs) && <span>{formatShellElapsed(msg.elapsedMs)} · </span>}
          <span>{formatTime(msg.createdAt)}</span>
          {copyButton}
        </div>
      </div>
    );
  }
  if (msg.role === 'user') {
    const imageAttachments = msg.attachments?.filter((att) => att.mimeType.startsWith('image/')) ?? [];
    const fileAttachments = msg.attachments?.filter((att) => !att.mimeType.startsWith('image/')) ?? [];
    return (
      <>
        {msg.toolCalls && <ToolTree calls={msg.toolCalls} />}
        <div className="mb-6 flex w-full justify-end">
          <div className="flex min-w-0 max-w-[min(80%,620px)] flex-col items-end gap-1.5">
            {imageAttachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                {imageAttachments.map((att) => (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => setPreviewImg({ url: att.url, name: att.name })}
                    title={`${att.name} (${formatSize(att.size)})`}
                    className="group/uimg relative overflow-hidden rounded-xl border border-border/80 bg-muted/30 shadow-xs transition-opacity hover:opacity-95"
                  >
                    <img
                      src={att.url}
                      alt={att.name}
                      className="max-h-52 max-w-64 cursor-zoom-in object-cover"
                    />
                  </button>
                ))}
              </div>
            )}
            {fileAttachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1">
                {fileAttachments.map((att) => {
                  const FileIcon = artifactIcon(att.name);
                  return (
                    <a
                      key={att.id}
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`${att.name} (${formatSize(att.size)})`}
                    >
                      <Tag icon={<FileIcon />}>{att.name}</Tag>
                    </a>
                  );
                })}
              </div>
            )}
            {msg.content.trim() && (
              <div className="glass-control whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-[14px] leading-relaxed text-foreground [overflow-wrap:break-word]">
                {msg.content}
              </div>
            )}
            <div className="pr-1 text-right text-[11px] leading-4 text-muted-foreground/70">{formatTime(msg.createdAt)}</div>
          </div>
        </div>
        <Dialog open={Boolean(previewImg)} onOpenChange={(open) => { if (!open) setPreviewImg(null); }}>
          {previewImg && (
            <DialogContent showCloseButton={false} className="flex max-h-[90vh] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]">
              <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-2">
                <DialogTitle className="min-w-0 truncate text-sm font-medium">{previewImg.name}</DialogTitle>
                <DialogDescription className="sr-only">{t('message.imagePreview')}</DialogDescription>
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPreviewImg(null)} aria-label={t('message.closePreview')}>
                  <X className="size-4" />
                </Button>
              </DialogHeader>
              <div className="flex max-h-[calc(90vh-49px)] items-center justify-center overflow-auto bg-muted/30 p-4">
                <img src={previewImg.url} alt={previewImg.name} className="max-h-[calc(90vh-81px)] max-w-full rounded-md object-contain" />
              </div>
            </DialogContent>
          )}
        </Dialog>
        <ArtifactList msg={msg} />
      </>
    );
  }
  return (
    <>
      {msg.toolCalls && <ToolTree calls={msg.toolCalls} />}
      <div className="group/msg mb-6 w-full max-w-[820px]">
        <div className="text-[14px] leading-7 text-foreground [overflow-wrap:break-word]">
          <MarkdownContent content={msg.content} />
        </div>
        <div className={cn(styles.messageTime, 'flex items-center gap-2')}>
          <span>{formatTime(msg.createdAt)}</span>
          {copyButton}
        </div>
      </div>
      <ArtifactList msg={msg} />
    </>
  );
}

// ── Run artifact list (files found by diffing the working directory)─────────────────────────────────

export function ArtifactList({ msg }: { msg: UiMessage }) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<{ path: string; html: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  if (!msg.artifacts?.length || !msg.conversationId) return null;

  const fileUrl = (p: string) =>
    `/api/workspaces/${msg.conversationId}/file?path=${encodeURIComponent(p)}`;

  const open = async (a: RunArtifact) => {
    // HTML: fetch as plain text, then preview via srcdoc iframe (sandbox has no same-origin,
    // so agent-generated scripts can't reach the app origin); other types open/download in a new tab
    if (/\.html?$/i.test(a.path)) {
      setLoading(a.path);
      try {
        const res = await fetch(fileUrl(a.path));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setPreview({ path: a.path, html: await res.text() });
      } catch {
        window.open(fileUrl(a.path), '_blank');
      } finally {
        setLoading(null);
      }
      return;
    }
    window.open(fileUrl(a.path), '_blank');
  };

  return (
    <div className="mb-2.5 mt-1.5 flex max-w-[800px] flex-col gap-1">
      <div className="flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
        <Folder className="size-3.5" aria-hidden="true" />{t('message.artifacts', { count: msg.artifacts.length })}
      </div>
      {msg.artifacts.map((a) => {
        const ArtifactIcon = artifactIcon(a.path);
        return (
          <Button
            key={a.path}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto w-full justify-start gap-2 bg-card px-3 py-2 text-left text-xs font-normal hover:border-gray-500"
            onClick={() => void open(a)}
            title={a.path}
          >
            <ArtifactIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{a.path}</span>
            <Badge variant="secondary" className="text-xs">
              {a.change === 'created' ? t('message.artifactCreated') : t('message.artifactUpdated')}
            </Badge>
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
              {loading === a.path ? '…' : formatSize(a.size)}
            </span>
          </Button>
        );
      })}
      <Dialog open={!!preview} onOpenChange={(open) => { if (!open) setPreview(null); }}>
        {preview && (
          <DialogContent showCloseButton={false} className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1080px]">
            <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-2">
              <DialogTitle className="min-w-0 truncate text-sm font-medium">{preview.path}</DialogTitle>
              <DialogDescription className="sr-only">{t('message.htmlPreview')}</DialogDescription>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPreview(null)} aria-label={t('message.closePreview')}>
                <X className="size-4" />
              </Button>
            </DialogHeader>
            <iframe className="min-h-0 w-full flex-1 border-0" sandbox="allow-scripts" srcDoc={preview.html} title={preview.path} />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

/** Render a turn's text/thinking/tools interleaved by arrival order (shared by live and replay) */
export function TurnItems({
  items,
  toolCalls,
  streaming = false,
}: {
  items: TurnItem[];
  toolCalls: ToolCall[];
  streaming?: boolean;
}) {
  const forest = useMemo(() => buildToolForest(toolCalls), [toolCalls]);
  const rootIds = new Set(forest.roots.map((call) => call.id));
  const renderedRoots = new Set<string>();
  const lastTextIndex = items.reduce((acc, item, i) => (item.kind === 'text' ? i : acc), -1);
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'tool') {
          const call = forest.byId.get(item.id);
          // Once an in-flight call gets its parent, show it only under the parent, not duplicated in the timeline.
          if (!call || !rootIds.has(call.id) || renderedRoots.has(call.id)) return null;
          renderedRoots.add(call.id);
          return (
            <div key={`t-${item.id}`} className={styles.toolTree} data-remixclip-tool-tree>
              <ToolSubtree root={call} byParent={forest.byParent} />
            </div>
          );
        }
        if (item.kind === 'thinking') {
          return <ThinkingBlock key={`k-${i}`} text={item.text} />;
        }
        const isLiveTail = streaming && i === lastTextIndex;
        return (
          <div key={`x-${i}`} className="mb-4 w-full max-w-[820px]">
            <div className="text-[14px] leading-7 text-foreground [overflow-wrap:break-word]">
              <MarkdownContent content={item.text} />
              {isLiveTail && <span className="animate-blink text-foreground">▍</span>}
            </div>
          </div>
        );
      })}
      {/* Calls missing their parent event are still readable; never lose tool output to an incomplete event stream. */}
      {forest.roots.filter((call) => !renderedRoots.has(call.id)).map((call) => (
        <div key={`t-${call.id}`} className={styles.toolTree} data-remixclip-tool-tree>
          <ToolSubtree root={call} byParent={forest.byParent} />
        </div>
      ))}
    </>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3 min-w-0 max-w-[820px] rounded-md border border-dashed border-border bg-secondary/30">
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="w-full justify-start gap-2 px-3 text-xs font-normal text-muted-foreground hover:text-foreground">
          <Brain className="size-4" aria-hidden="true" />{t('message.thinking')}
          <ChevronDown className={cn('ml-auto size-4 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="max-h-60 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">{text}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Build a forest keyed by call ID; orphans are promoted to roots and anomalous parent cycles cut, avoiding dropped rows or infinite recursion. */
function buildToolForest(calls: ToolCall[]) {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const parentIds = new Map(
    Array.from(byId.values(), (call) => [
      call.id,
      call.parentToolUseId && byId.has(call.parentToolUseId) ? call.parentToolUseId : undefined,
    ]),
  );
  const visited = new Set<string>();
  for (const id of byId.keys()) {
    const path = new Set<string>();
    let current: string | undefined = id;
    while (current && !visited.has(current)) {
      if (path.has(current)) {
        parentIds.set(current, undefined);
        break;
      }
      path.add(current);
      current = parentIds.get(current);
    }
    for (const node of path) visited.add(node);
  }
  const byParent = new Map<string, ToolCall[]>();
  const roots: ToolCall[] = [];
  for (const call of byId.values()) {
    const parent = parentIds.get(call.id);
    if (!parent) roots.push(call);
    else {
      const children = byParent.get(parent) ?? [];
      children.push(call);
      byParent.set(parent, children);
    }
  }
  return { byId, byParent, roots };
}

/** Each call's details expand independently; child calls keep visible hierarchy guide lines. */
function ToolSubtree({
  root,
  byParent,
  depth = 0,
}: {
  root: ToolCall;
  byParent: Map<string, ToolCall[]>;
  depth?: number;
}) {
  const children = byParent.get(root.id) ?? [];
  return (
    <div className="min-w-0" data-tool-id={root.id} data-tool-depth={depth}>
      <ToolRow call={root} childCount={children.length} />
      {children.length > 0 && (
        <div className={cn('mb-1 ml-2 min-w-0 border-l border-border pl-3', depth >= 4 && 'ml-0 border-l-0 pl-0')}>
          {children.map((call) => (
            <ToolSubtree key={call.id} root={call} byParent={byParent} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ToolTree({ calls }: { calls: ToolCall[] }) {
  const forest = useMemo(() => buildToolForest(calls), [calls]);
  if (forest.roots.length === 0) return null;
  return (
    <div className={styles.toolTree} data-remixclip-tool-tree>
      {forest.roots.map((call) => (
        <ToolSubtree key={call.id} root={call} byParent={forest.byParent} />
      ))}
    </div>
  );
}

function ToolRow({ call, childCount = 0 }: { call: ToolCall; childCount?: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const isSubagent = Boolean(call.subagentType);
  const KindIcon = isSubagent ? Bot : KIND_ICON[toolKind(call.name, call.input)];
  const summary = toolTitle(call.name, call.input) || summarizeInput(call.input);
  const status = call.pending ? t('tool.running') : call.isError ? t('tool.failed') : call.result !== undefined ? t('tool.completed') : t('tool.called');
  const inputText = typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2);
  const showResult = call.result !== undefined && call.result.trim() !== call.liveText?.trim();
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1 min-w-0">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className={styles.toolRow}
          title={summary || call.name}
          aria-label={t('tool.rowAria', {
            label: isSubagent ? t('tool.subagentAria', { type: call.subagentType ?? '' }) : call.name,
            summary: summary || t('tool.viewDetails'),
          })}
        >
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <KindIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-[40%] shrink-0 truncate font-medium text-foreground">
            {isSubagent ? t('tool.subagentLabel', { type: call.subagentType ?? '' }) : call.name}
          </span>
          <span className={styles.toolSummary}>{summary || (call.liveText ? call.liveText.slice(-120) : '')}</span>
          {childCount > 0 && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{t('tool.childCount', { count: childCount })}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px]" aria-label={t('tool.statusAria', { status })}>
            {call.pending ? (
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
            ) : call.isError ? (
              <CircleX className="size-3" aria-hidden="true" />
            ) : call.result !== undefined ? (
              <Check className="size-3" aria-hidden="true" />
            ) : null}
            <span className="max-[600px]:sr-only">{status}</span>
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mb-2 ml-6 min-w-0 space-y-3 rounded-md border border-border bg-background-200 p-3 text-xs">
          {inputText && (
            <section aria-label={t('tool.inputAria')}>
              <div className="mb-1.5 font-medium text-muted-foreground">{t('tool.arguments')}</div>
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{inputText}</pre>
            </section>
          )}
          {call.liveText && (
            <section aria-label={t('tool.subagentReply')}>
              <div className="mb-1.5 font-medium text-muted-foreground">{t('tool.subagentReply')}</div>
              <div className="max-h-80 overflow-auto leading-relaxed">
                <MarkdownContent content={call.liveText} />
              </div>
            </section>
          )}
          {showResult && (
            <section aria-label={call.isError ? t('tool.errorAria') : t('tool.outputAria')}>
              <div className="mb-1.5 font-medium text-muted-foreground">
                {call.isError ? t('tool.execFailed') : call.pending ? t('tool.liveOutput') : t('tool.execResult')}
              </div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
                {call.result || t('tool.noTextOutput')}
              </pre>
            </section>
          )}
          {!inputText && !call.liveText && !showResult && (
            <p className="text-muted-foreground">{call.pending ? t('tool.waiting') : t('tool.noDetails')}</p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

