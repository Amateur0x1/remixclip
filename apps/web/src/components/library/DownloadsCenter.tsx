'use client';

/**
 * [INPUT]: GET /api/library/downloads (every in-flight source download + the last day's results).
 * [OUTPUT]: One poller for the whole window (`DownloadsProvider`), a header indicator that spins
 *           while work is in flight, and a popover listing each download with its progress.
 * [POS]: Cross-pane download visibility. Downloads are started in the library but executed by the
 *        daemon, so the indicator lives in the window chrome: it stays readable from a chat.
 *
 * Popover, not dropdown menu: the panel holds rich, interactive content (progress bars, statuses)
 * rather than a list of commands, which is exactly the Popover / DropdownMenu split in Radix.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { LibraryDownloadEntry } from '@remixclip/contracts';
import { ArrowDownToLine, Check, LoaderCircle, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { downloadLibraryVideo, listLibraryDownloads, platformLabel } from '@/providers/library';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { SocialPlatform } from '@remixclip/contracts';

/** Fast enough to feel live, slow enough that an idle window is not a polling loop. */
const ACTIVE_POLL_MS = 1200;
const IDLE_POLL_MS = 8000;

interface DownloadsContextValue {
  downloads: LibraryDownloadEntry[];
  /** Rows the daemon is still working on. */
  active: LibraryDownloadEntry[];
  /** Latest row for one item, so a caller can show its own progress. */
  entryFor: (itemId: string) => LibraryDownloadEntry | undefined;
  /** Start (idempotently) and resolve when the daemon reports the row terminal. */
  start: (itemId: string) => Promise<void>;
  refresh: () => void;
}

const DownloadsContext = createContext<DownloadsContextValue | null>(null);

function isActive(entry: LibraryDownloadEntry): boolean {
  return entry.media.status === 'pending' || entry.media.status === 'downloading';
}

export function DownloadsProvider({ children }: { children: ReactNode }) {
  const [downloads, setDownloads] = useState<LibraryDownloadEntry[]>([]);
  const activeRef = useRef(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    void listLibraryDownloads()
      .then((next) => {
        if (mountedRef.current) setDownloads(next);
      })
      .catch(() => {
        // A failed poll is not worth an error banner: the next tick retries, and the header is
        // decoration — nothing downstream breaks when it is empty.
      });
  }, []);

  // A self-rescheduling timeout instead of an interval: the cadence follows whether anything is
  // actually running, without tearing the effect down on every state change.
  useEffect(() => {
    mountedRef.current = true;
    let timer: number | undefined;
    let cancelled = false;
    const tick = () => {
      void listLibraryDownloads()
        .then((next) => {
          if (cancelled) return;
          setDownloads(next);
          activeRef.current = next.some(isActive);
        })
        .catch(() => { /* keep the previous list */ })
        .finally(() => {
          if (cancelled) return;
          timer = window.setTimeout(tick, activeRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
        });
    };
    tick();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const active = useMemo(() => downloads.filter(isActive), [downloads]);

  const entryFor = useCallback(
    (itemId: string) => downloads.find((entry) => entry.itemId === itemId),
    [downloads],
  );

  const start = useCallback(async (itemId: string) => {
    await downloadLibraryVideo(itemId);
    refresh();
  }, [refresh]);

  const value = useMemo<DownloadsContextValue>(
    () => ({ downloads, active, entryFor, start, refresh }),
    [downloads, active, entryFor, start, refresh],
  );

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloads(): DownloadsContextValue {
  const value = useContext(DownloadsContext);
  if (!value) throw new Error('useDownloads must be used inside <DownloadsProvider>');
  return value;
}

// ── Header indicator ───────────────────────────────────────────────────────

export function DownloadsButton() {
  const { downloads, active } = useDownloads();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const working = active.length > 0;

  // Hover opens it, but leaving must not fight with a click that just pinned it open: the timer is
  // shared, so re-entering the panel cancels the close.
  const cancelClose = () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };
  useEffect(() => cancelClose, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No Tooltip wrapper: the popover itself opens on hover, and stacking two Radix triggers on
          one button fights over the same pointer handlers. */}
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          title={working ? t('downloads.ariaActive', { count: active.length }) : t('downloads.aria')}
          aria-label={working ? t('downloads.ariaActive', { count: active.length }) : t('downloads.aria')}
          aria-busy={working}
          className={cn(
            'relative size-7 text-muted-foreground hover:bg-secondary hover:text-foreground',
            working && 'text-foreground',
          )}
          onMouseEnter={() => { cancelClose(); setOpen(true); }}
          onMouseLeave={scheduleClose}
          onClick={(event) => {
            // Radix's trigger TOGGLES, and hover has already opened the panel — so a click would
            // instantly close what the pointer just revealed. Click means "keep it open"; the
            // panel closes on leave, Esc or an outside click.
            event.preventDefault();
            cancelClose();
            setOpen(true);
          }}
        >
          {working
            ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            : <ArrowDownToLine className="size-4" aria-hidden="true" />}
          {working && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-medium leading-3.5 text-primary-foreground tabular-nums">
              {active.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[340px] p-0"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
          <ArrowDownToLine className="size-3.5 text-muted-foreground" aria-hidden="true" />
          <span className="text-xs font-medium text-foreground">{t('downloads.title')}</span>
          {working && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {t('downloads.activeCount', { count: active.length })}
            </span>
          )}
        </div>
        <div className="max-h-[320px] overflow-y-auto p-1.5 scrollbar-thin" data-remixclip-downloads-list>
          {downloads.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11.5px] leading-5 text-muted-foreground">
              {t('downloads.empty')}
            </div>
          ) : downloads.map((entry) => <DownloadRow key={entry.media.id} entry={entry} />)}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DownloadRow({ entry }: { entry: LibraryDownloadEntry }) {
  const { t } = useI18n();
  const { media } = entry;
  const percent = Math.max(0, Math.min(100, Math.round((media.progress ?? 0) * 100)));
  const failed = media.status === 'failed';
  const ready = media.status === 'ready';

  return (
    <div className="rounded-md px-2 py-1.5 hover:bg-secondary/60">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={entry.title}>
          {entry.title || t('library.untitled')}
        </span>
        {ready && <Check className="size-3.5 shrink-0 text-status-done" aria-hidden="true" />}
        {failed && <TriangleAlert className="size-3.5 shrink-0 text-status-interrupted" aria-hidden="true" />}
        {(media.status === 'pending' || media.status === 'downloading') && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">{percent}%</span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="shrink-0 text-[10.5px] text-muted-foreground/80">
          {platformLabel(entry.platform as SocialPlatform)}
        </span>
        {failed ? (
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-status-interrupted" title={media.error}>
            {media.error || t('downloads.failed')}
          </span>
        ) : ready ? (
          <span className="min-w-0 flex-1 text-[10.5px] text-muted-foreground/80">
            {t('downloads.done')}
          </span>
        ) : (
          <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-500"
              style={{ width: `${media.status === 'pending' ? 4 : percent}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}
