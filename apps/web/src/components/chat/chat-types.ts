/**
 * [INPUT]: @remixclip/contracts chat contract types, tool-kind classification rules and Lucide icons.
 * [OUTPUT]: Chat UI state types, shared styles and pure-function utilities.
 * [POS]: Type and pure-utility layer shared by src/components/chat and src/components/workspace.
 */
import type { ChatAttachment, ChatMessage, WorkspaceFileKind } from '@remixclip/contracts';
import { workspaceFileKind } from '@remixclip/contracts';
import {
  BookOpen,
  File,
  FileArchive,
  FileCode2,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  Film,
  Image,
  Music,
  Pencil,
  Search,
  Terminal,
  Trash2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { getLocale } from '@/i18n';
import type { ToolKind } from '@/runtime/chat/tool-kind';

export interface PendingAttachment {
  clientId: string;
  name: string;
  mimeType: string;
  size: number;
  previewUrl?: string;
  uploading: boolean;
  error?: string;
  uploaded?: ChatAttachment;
}

/** Semantic icon for a tool row (UI projection of the tool-kind classification; unrecognized ones fall back to 'other') */
export const KIND_ICON: Record<ToolKind, LucideIcon> = {
  read: BookOpen,
  write: FilePenLine,
  edit: Pencil,
  delete: Trash2,
  search: Search,
  exec: Terminal,
  image: Image,
  other: Wrench,
};

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  /** ACP in-flight row: result is a process-output preview; set false once the final tool_result arrives. */
  pending?: boolean;
  /** Non-empty means this call happens inside a subagent (the parent Task call id) */
  parentToolUseId?: string;
  /** Task subagent type */
  subagentType?: string;
  /** Streamed text from the subagent (text_delta tagged with parentToolUseId) */
  liveText?: string;
}

/** One thing landing in a turn, in arrival order (aligned with the open-design ShellItem/TurnBlock timeline) */
export type TurnItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string };

export interface LiveTurn {
  statusLabel: string;
  /** Got thinking but hasn't spoken/acted yet → the shell header shows 'Thinking' */
  thinking: boolean;
  items: TurnItem[];
  toolCalls: ToolCall[];
  error?: string;
  stopped?: boolean;
  startedAt: number;
}

export interface UiMessage extends ChatMessage {
  toolCalls?: ToolCall[];
  turnItems?: TurnItem[];
  stopped?: boolean;
  elapsedMs?: number;
  error?: string;
}

/** A file the artifact viewer can open; every row (message list, folder panel) produces one. */
export interface ArtifactTarget {
  conversationId: string;
  /** POSIX path relative to the project working dir. */
  path: string;
  name?: string;
  size?: number;
  kind?: WorkspaceFileKind;
  /** Cache-buster / version hint (file mtime). */
  mtimeMs?: number;
}

/** Read URL for one working-dir file; Range requests (video seeking) are handled by `sendFile`. */
export function artifactFileUrl(
  conversationId: string,
  filePath: string,
  version?: number,
): string {
  const params = new URLSearchParams({ path: filePath });
  if (version) params.set('v', String(Math.round(version)));
  return `/api/workspaces/${conversationId}/file?${params.toString()}`;
}

/** Merge persistent identity with richer live metadata, independently of response arrival order. */
export function mergeMessages(persisted: UiMessage[], live: UiMessage[]): UiMessage[] {
  const result = persisted.slice();
  for (const message of live) {
    const index = result.findIndex((item) => item.id === message.id || (
      item.conversationId === message.conversationId && item.runId && item.runId === message.runId && item.role === message.role
    ));
    if (index < 0) result.push(message);
    else {
      const stored = result[index]!;
      result[index] = {
        ...stored,
        toolCalls: message.toolCalls ?? stored.toolCalls,
        turnItems: message.turnItems ?? stored.turnItems,
        elapsedMs: message.elapsedMs ?? stored.elapsedMs,
        stopped: message.stopped ?? stored.stopped,
        error: message.error ?? stored.error,
        artifacts: stored.artifacts?.length ? stored.artifacts : message.artifacts,
        attachments: stored.attachments?.length ? stored.attachments : message.attachments,
      };
    }
  }
  return result;
}

export const EMPTY_TURN: LiveTurn = {
  statusLabel: '',
  thinking: false,
  items: [],
  toolCalls: [],
  startedAt: 0,
};

// ── Tailwind composite styles: name reused or long utility strings here; state differences are spliced conditionally in JSX ──
export const styles = {
  spinner: 'size-3 shrink-0 animate-spin rounded-full border-2 border-border border-t-foreground',
  dialogContent: 'flex max-h-[84vh] w-[620px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px]',
  dialogHeader: 'shrink-0 border-b border-border px-6 py-4',
  dialogFooter: 'shrink-0 border-t border-border px-6 py-4',
  dialogBody: 'min-h-0 flex-1 overflow-y-auto px-6 py-4',
  dialogHint: 'mb-4 text-sm leading-relaxed text-muted-foreground',
  formRow: 'mb-4 flex items-center gap-3',
  formRowLabel: 'w-20 shrink-0 text-sm text-muted-foreground',
  toolTree: 'mb-3 min-w-0 max-w-[820px]',
  toolRow: 'h-auto min-h-9 w-full min-w-0 justify-start gap-2 rounded-md px-2 py-2 text-left text-xs font-normal text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
  pathError: 'w-full text-destructive',
  execError: 'mt-1.5 rounded-md bg-secondary px-3 py-2 text-sm text-foreground',
  queueHint: 'mb-2 flex items-center gap-2 rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-muted-foreground',
  messageTime: 'mt-1.5 text-[11px] leading-4 text-muted-foreground/70',
  shellStopped: 'text-sm text-muted-foreground',
  toolSummary: 'min-w-0 flex-1 truncate text-left text-muted-foreground',
} as const;

/**
 * Replayed message → UI message: the persisted turn process feeds the same toolCalls/turnItems the
 * live reducer produces, so MessageView keeps one rendering path and the operation chips survive
 * a reload instead of existing only in memory.
 */
export function withTurnProcess(message: ChatMessage): UiMessage {
  if (!message.process) return message;
  return {
    ...message,
    toolCalls: message.process.toolCalls,
    turnItems: message.process.items,
    // The "Worked for …" header is rendered from elapsedMs on both live and replayed turns.
    elapsedMs: message.process.elapsedMs,
  };
}

/** Merge same-kind deltas into the previous segment, otherwise start a new one (preserving arrival order) */
export function appendDelta(items: TurnItem[], kind: 'text' | 'thinking', delta: string): TurnItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    const next = items.slice();
    next[next.length - 1] = { ...last, text: last.text + delta };
    return next;
  }
  return [...items, { kind, text: delta }];
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function artifactIcon(p: string): LucideIcon {
  if (/\.(csv|xlsx?|tsv)$/i.test(p)) return FileSpreadsheet;
  const kind = workspaceFileKind(p);
  if (kind === 'video') return Film;
  if (kind === 'audio') return Music;
  if (kind === 'image') return Image;
  if (kind === 'html' || kind === 'code') return FileCode2;
  if (kind === 'markdown' || kind === 'text') return FileText;
  if (kind === 'archive') return FileArchive;
  return File;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const isToday = d.toDateString() === new Date().toDateString();
  if (isToday) return formatTime(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(ts)}`;
}

export function summarizeInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const candidate = obj.command ?? obj.file_path ?? obj.path ?? obj.prompt ?? obj.pattern;
    if (typeof candidate === 'string') return candidate.slice(0, 80);
  }
  return JSON.stringify(input)?.slice(0, 80) ?? '';
}
