'use client';

/**
 * [INPUT]: The open conversation id, the latest run artifacts, whether a run is live, and an
 *          open-file callback.
 * [OUTPUT]: A right-hand artifact folder panel: recent outputs on top, a lazily expanded project
 *           file tree below, with refresh / close actions.
 * [POS]: The chat's file browser. It never renders file bytes itself — every row hands off to
 *        ArtifactPreviewDialog, so video / HTML / text share one viewer.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceEntry, WorkspaceTreeResponse } from '@remixclip/contracts';
import { workspaceFileKind } from '@remixclip/contracts';
import {
  ChevronRight,
  CircleAlert,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { artifactIcon, formatSize, type ArtifactTarget } from './chat-types';

type DirState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: WorkspaceEntry[]; truncated: boolean };

export function ArtifactPanel({
  conversationId,
  running,
  onOpen,
  onClose,
}: {
  conversationId: string;
  running: boolean;
  onOpen: (target: ArtifactTarget) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Bumped when the conversation changes so late responses from the old project are dropped. */
  const generationRef = useRef(0);

  const loadDir = useCallback(
    async (dir: string) => {
      const generation = generationRef.current;
      // Keep the rows already on screen while polling; replacing them with a spinner every few
      // seconds would make a live run's file list flicker.
      setDirs((prev) => (prev[dir] ? prev : { ...prev, [dir]: { status: 'loading' } }));
      try {
        const params = new URLSearchParams();
        if (dir) params.set('path', dir);
        const query = params.toString();
        const res = await fetch(
          `/api/workspaces/${conversationId}/tree${query ? `?${query}` : ''}`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as WorkspaceTreeResponse;
        if (generation !== generationRef.current) return;
        setDirs((prev) => ({
          ...prev,
          [dir]: { status: 'ready', entries: data.entries ?? [], truncated: Boolean(data.truncated) },
        }));
      } catch {
        if (generation !== generationRef.current) return;
        setDirs((prev) => ({ ...prev, [dir]: { status: 'error' } }));
      }
    },
    [conversationId],
  );

  // Switching conversations discards every cached directory; the panel always starts at the root.
  useEffect(() => {
    generationRef.current += 1;
    setDirs({});
    setExpanded(new Set());
    void loadDir('');
  }, [loadDir]);

  // A finished run changes the tree outside HTTP: re-read the root and every open folder.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) {
      void loadDir('');
      for (const dir of expanded) void loadDir(dir);
    }
    wasRunning.current = running;
  }, [running, expanded, loadDir]);

  // While a run is live, poll the visible levels so files appear as the agent writes them.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      void loadDir('');
      for (const dir of expanded) void loadDir(dir);
    }, 4000);
    return () => window.clearInterval(id);
  }, [running, expanded, loadDir]);

  const refresh = useCallback(() => {
    void loadDir('');
    for (const dir of expanded) void loadDir(dir);
  }, [expanded, loadDir]);

  const toggleDir = useCallback(
    (entryPath: string) => {
      const opening = !expanded.has(entryPath);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (opening) next.add(entryPath);
        else next.delete(entryPath);
        return next;
      });
      if (opening && !dirs[entryPath]) void loadDir(entryPath);
    },
    [dirs, expanded, loadDir],
  );

  // One row per produced path; later runs win because they are the newest bytes.
  const root = dirs[''];
  const rootEmpty = root?.status === 'ready' && root.entries.length === 0;

  const openEntry = useCallback(
    (entry: WorkspaceEntry) => {
      onOpen({
        conversationId,
        path: entry.path,
        name: entry.name,
        size: entry.size,
        kind: entry.kind ?? workspaceFileKind(entry.path),
        mtimeMs: entry.mtimeMs,
      });
    },
    [conversationId, onOpen],
  );

  const renderDir = (dir: string, depth: number): ReactNode => {
    const state = dirs[dir];
    const indent = { paddingLeft: 10 + depth * 12 };
    if (!state || state.status === 'loading') {
      return (
        <div className="flex items-center gap-1.5 py-1.5 text-[11.5px] text-muted-foreground" style={indent}>
          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
          {t('artifacts.loading')}
        </div>
      );
    }
    if (state.status === 'error') {
      return (
        <button
          type="button"
          onClick={() => void loadDir(dir)}
          className="flex w-full items-center gap-1.5 rounded-md py-1.5 text-left text-[11.5px] text-muted-foreground"
          style={indent}
        >
          <CircleAlert className="size-3" aria-hidden="true" />
          {t('artifacts.loadFailed')}
          <span className="ml-auto text-foreground">{t('artifacts.retry')}</span>
        </button>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div className="py-1.5 text-[11.5px] text-muted-foreground/70" style={indent}>
          {t('artifacts.folderEmpty')}
        </div>
      );
    }
    return (
      <>
        {state.entries.map((entry) => {
          if (entry.type === 'dir') {
            const open = expanded.has(entry.path);
            return (
              <div key={`d:${entry.path}`}>
                <button
                  type="button"
                  onClick={() => toggleDir(entry.path)}
                  title={entry.path}
                  aria-expanded={open}
                  className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-left text-xs text-foreground"
                  style={indent}
                >
                  <ChevronRight
                    className={cn('size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
                    aria-hidden="true"
                  />
                  {open
                    ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0 truncate">{entry.name}</span>
                </button>
                {open && renderDir(entry.path, depth + 1)}
              </div>
            );
          }
          const EntryIcon = artifactIcon(entry.path);
          return (
            <button
              key={`f:${entry.path}`}
              type="button"
              onClick={() => openEntry(entry)}
              title={entry.path}
              className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-1.5 text-left text-xs text-foreground"
              style={{ paddingLeft: 22 + depth * 12 }}
            >
              <EntryIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 tabular-nums text-[10.5px] text-muted-foreground/80">
                {formatSize(entry.size)}
              </span>
            </button>
          );
        })}
        {state.truncated && (
          <div className="py-1 text-[10.5px] text-muted-foreground/70" style={indent}>
            {t('artifacts.truncated', { count: state.entries.length })}
          </div>
        )}
      </>
    );
  };

  return (
    <aside
      id="artifact-panel"
      data-remixclip-artifact-panel
      aria-label={t('artifacts.title')}
      className="relative z-10 flex h-full w-[340px] min-w-[260px] max-w-[46%] shrink-0 flex-col border-l border-border/70 bg-background max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:w-[min(88vw,360px)] max-md:max-w-none max-md:shadow-xl"
    >
      {/* Same height as the conversation header next door: the two panes share one top strip,
          while the border keeps the file column visually separate all the way down. */}
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-3">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-foreground">{t('artifacts.title')}</span>
        {root?.status === 'ready' && (
          <span className="rounded-full bg-secondary px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
            {root.entries.filter((entry) => entry.type === 'file').length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={refresh}
            title={t('artifacts.refresh')}
            aria-label={t('artifacts.refresh')}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={onClose}
            title={t('artifacts.close')}
            aria-label={t('artifacts.close')}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2 scrollbar-thin" data-remixclip-artifact-scroll>
        {rootEmpty ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-[11.5px] leading-5 text-muted-foreground">
            <FolderOpen className="size-7 text-muted-foreground/50" aria-hidden="true" />
            {t('artifacts.empty')}
          </div>
        ) : (
          <section>{renderDir('', 0)}</section>
        )}
      </div>
    </aside>
  );
}
