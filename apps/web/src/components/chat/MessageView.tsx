'use client';

/**
 * [INPUT]: UiMessage (with user image/file attachments, assistant turnItems, toolCalls, artifacts).
 * [OUTPUT]: Message bubbles, attachment thumbnails and preview dialog, the turn's "Worked for …" fold (chips / thinking / artifacts inside), and its final answer.
 * [POS]: Core renderer for a single message in the conversation stream and for an in-progress Turn.
 */
import { useMemo, useState, type ReactNode } from 'react';
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
import {
  commandFile,
  commandOf,
  fileOf,
  isCommandTool,
  searchPattern,
  toolKind,
  toolTitle,
  type ToolKind,
} from '@/runtime/chat/tool-kind';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './MarkdownContent';
import { ArtifactPreviewDialog } from './ArtifactPreviewDialog';
import { RunErrorNotice } from './RunErrorNotice';
import {
  KIND_ICON,
  artifactIcon,
  formatSize,
  formatTime,
  styles,
  summarizeInput,
  type ArtifactTarget,
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
        <TurnItems
          items={msg.turnItems}
          toolCalls={msg.toolCalls ?? []}
          collapse
          elapsedMs={msg.elapsedMs}
          processExtra={<ArtifactList msg={msg} />}
        />
        {msg.error && <RunErrorNotice error={msg.error} />}
        <div className={cn(styles.messageTime, 'flex items-center gap-2')}>
          {msg.stopped && <span className={styles.shellStopped}>{t('message.stoppedPrefix')}</span>}
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
            {/* max-w-full + anywhere, not break-word: the bubble is a fit-content flex item, and
                break-word does not shrink its min-content width — one pasted video URL (3900px of
                unbreakable signature) made the bubble that wide and pushed it off-screen. */}
            {msg.content.trim() && (
              <div className="glass-control max-w-full whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-[14px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
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
        {msg.content.trim() && (
          <div className="text-[14px] leading-7 text-foreground [overflow-wrap:break-word]">
            <MarkdownContent content={msg.content} />
          </div>
        )}
        {msg.error && <RunErrorNotice error={msg.error} />}
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
  const [target, setTarget] = useState<ArtifactTarget | null>(null);
  // A long run can touch hundreds of files; the list is reference material, not the answer, so it
  // starts folded into one summary row (the turn's text stays the only thing demanding attention).
  const [open, setOpen] = useState(false);
  const conversationId = msg.conversationId;
  if (!msg.artifacts?.length || !conversationId) return null;
  const totalSize = msg.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-2.5 mt-1.5 max-w-[800px]">
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-xs font-normal text-muted-foreground hover:bg-secondary/70 hover:text-foreground"
        >
          <ChevronRight className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden="true" />
          <Folder className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="shrink-0">{t('message.artifacts', { count: msg.artifacts.length })}</span>
          <span className="shrink-0 tabular-nums text-muted-foreground/70">
            {t('message.artifactsSize', { size: formatSize(totalSize) })}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 flex max-h-[340px] flex-col gap-1 overflow-y-auto pr-1 scrollbar-thin">
          {msg.artifacts.map((a) => {
            const ArtifactIcon = artifactIcon(a.path);
            return (
              <Button
                key={a.path}
                type="button"
                variant="outline"
                size="sm"
                className="h-auto w-full justify-start gap-2 bg-card px-3 py-2 text-left text-xs font-normal hover:border-gray-500"
                onClick={() =>
                  setTarget({
                    conversationId,
                    path: a.path,
                    name: a.path.split('/').pop() ?? a.path,
                    size: a.size,
                  })}
                title={a.path}
              >
                <ArtifactIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{a.path}</span>
                <Badge variant="secondary" className="text-xs">
                  {a.change === 'created' ? t('message.artifactCreated') : t('message.artifactUpdated')}
                </Badge>
                <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                  {formatSize(a.size)}
                </span>
              </Button>
            );
          })}
        </div>
      </CollapsibleContent>
      <ArtifactPreviewDialog target={target} onClose={() => setTarget(null)} />
    </Collapsible>
  );
}

/** Render a turn's text/thinking/tools interleaved by arrival order (shared by live and replay) */
export function TurnItems({
  items,
  toolCalls,
  streaming = false,
  collapse = false,
  elapsedMs,
  processExtra,
}: {
  items: TurnItem[];
  toolCalls: ToolCall[];
  streaming?: boolean;
  /** Finished turns fold everything before the final answer into one "Worked for …" row. */
  collapse?: boolean;
  elapsedMs?: number;
  /** Artifact list and other process-only content that belongs inside the fold. */
  processExtra?: ReactNode;
}) {
  const forest = useMemo(() => buildToolForest(toolCalls), [toolCalls]);
  const rootIds = new Set(forest.roots.map((call) => call.id));
  const seen = new Set<string>();
  // One inline chip per run of same-kind calls, in place of the row-per-call tree: a turn that runs
  // fifty commands still reads as "Ran commands ×12" between two paragraphs, and every chip opens to
  // the full detail on click. The process stays available — just not sprawled across the page.
  const runs: ToolRunData[] = [];
  let active: ToolRunData | null = null;
  let afterTool = false;
  items.forEach((item, i) => {
    if (item.kind !== 'tool') {
      afterTool = false;
      active = null;
      return;
    }
    const call = forest.byId.get(item.id);
    // Children render inside their parent's subtree; a child event must not split the parent's run.
    if (!call || !rootIds.has(call.id) || seen.has(call.id)) return;
    seen.add(call.id);
    const kind = toolKind(call.name, call.input);
    if (afterTool && active && active.kind === kind) {
      active.calls.push(call);
    } else {
      active = { index: i, kind, calls: [call] };
      runs.push(active);
    }
    afterTool = true;
  });
  // Calls missing their parent event are still readable; never lose tool output to an incomplete event stream.
  for (const call of forest.roots) {
    if (seen.has(call.id)) continue;
    runs.push({ index: -1, kind: toolKind(call.name, call.input), calls: [call] });
  }
  const runByIndex = new Map(runs.filter((run) => run.index >= 0).map((run) => [run.index, run]));
  const lastTextIndex = items.reduce((acc, item, i) => (item.kind === 'text' ? i : acc), -1);
  // Everything before the final answer is process; the answer is the only thing that must be read.
  // `> 0` keeps a turn that is just one paragraph free of an empty fold.
  const collapseAt = collapse && !streaming && lastTextIndex > 0 ? lastTextIndex : -1;

  const nodeFor = (item: TurnItem, i: number): ReactNode => {
    if (item.kind === 'tool') {
      const run = runByIndex.get(i);
      return run ? <ToolRun key={`run-${i}`} run={run} byParent={forest.byParent} /> : null;
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
  };

  const process = (
    <>
      {items.map((item, i) => (i === collapseAt ? null : nodeFor(item, i)))}
      {runs.filter((run) => run.index < 0).map((run) => (
        <ToolRun key={`run-x-${run.calls[0]!.id}`} run={run} byParent={forest.byParent} />
      ))}
    </>
  );

  if (collapseAt >= 0) {
    return (
      <>
        <WorkedFor elapsedMs={elapsedMs}>
          {process}
          {processExtra}
        </WorkedFor>
        {nodeFor(items[collapseAt]!, collapseAt)}
      </>
    );
  }
  return process;
}

/**
 * The outermost fold of a finished turn.
 *
 * A fifty-command recreation used to spread chips, thinking blocks and the artifact row down the
 * page, burying the one paragraph the user actually asked for. Everything the agent did collapses
 * behind a single "Worked for 3m 58s" row — closed by default, one click from the same timeline.
 *
 * Modeled on Open Design's ExecutionShell (Apache-2.0, see NOTICE): text produced before the
 * conclusion is process and folds away; the conclusion itself stays outside.
 */
function WorkedFor({ elapsedMs, children }: { elapsedMs?: number; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const duration = formatShellElapsed(elapsedMs);
  const label = duration ? t('message.workedFor', { duration }) : t('message.workedForUnknown');
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3 w-full max-w-[820px]" data-remixclip-worked-for>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-8 w-full justify-start gap-1.5 rounded-none border-b border-border/60 px-0.5 text-[13px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          <span className="tabular-nums">{label}</span>
          <ChevronDown className={cn('size-4 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-3">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

interface ToolRunData {
  /** Timeline position of the run's first item; -1 for orphan calls appended at the end. */
  index: number;
  kind: ToolKind;
  calls: ToolCall[];
}

/** Verb for a run chip; `other` tools keep their own name instead of pretending to be a known action. */
function runVerb(kind: ToolKind, toolName: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (kind) {
    case 'exec': return t('tool.runCommands');
    case 'read': return t('tool.runRead');
    case 'edit': return t('tool.runEdit');
    case 'write': return t('tool.runWrite');
    case 'delete': return t('tool.runDelete');
    case 'search': return t('tool.runSearch');
    case 'image': return t('tool.runImage');
    default: return toolName;
  }
}

/** The one file / pattern a chip can name, using the same provable-target rules as the tool rows. */
function runTarget(call: ToolCall): string {
  if (isCommandTool(call.name)) {
    return commandFile(commandOf(call.input))?.label ?? '';
  }
  const file = fileOf(call.input);
  if (file) return file.label;
  return searchPattern(call.name, call.input) ?? '';
}

/**
 * A single collapsed chip standing in for one run of tool calls.
 *
 * The chip names what happened ("Edited config.ts", "Ran commands ×6") and opens to the same rows
 * the timeline used to show outright — so nothing is deleted, it is just one click away. Failures
 * show as a red count in the header instead of unfolding the run: a 50-command turn that opens
 * itself is exactly the wall this replaced.
 */
function ToolRun({ run, byParent }: { run: ToolRunData; byParent: Map<string, ToolCall[]> }) {
  const { t } = useI18n();
  const first = run.calls[0]!;
  const failed = run.calls.filter((call) => call.isError).length;
  const pending = run.calls.some((call) => call.pending);
  const [open, setOpen] = useState(false);
  const Icon = first.subagentType ? Bot : KIND_ICON[run.kind];
  const verb = runVerb(run.kind, first.name, t);
  const target = runTarget(first);
  const count = run.calls.length;
  const label = count > 1 || !target ? verb : `${verb} ${target}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-1.5 min-w-0 max-w-[820px]" data-remixclip-tool-tree>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="h-auto min-h-7 max-w-full justify-start gap-1.5 rounded-lg border border-border/60 bg-secondary/40 px-2 py-1 text-xs font-normal text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
          title={toolTitle(first.name, first.input) || first.name}
          aria-label={t('tool.runAria', { label, count })}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{label}</span>
          {count > 1 && <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/80">×{count}</span>}
          {failed > 0 && (
            <span className="shrink-0 text-[11px] text-destructive">{t('tool.runFailed', { count: failed })}</span>
          )}
          {pending && <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden="true" />}
          <ChevronDown className={cn('size-3.5 shrink-0 opacity-60 transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 min-w-0 border-l border-border/70 pl-2">
          {run.calls.map((call) => (
            <ToolSubtree key={call.id} root={call} byParent={byParent} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
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

