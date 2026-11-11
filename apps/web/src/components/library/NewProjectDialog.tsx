'use client';

/**
 * [INPUT]: The shared download feed and the library list (GET /api/library/items).
 * [OUTPUT]: The "new project" dialog, whose ONE mandatory field is material: a searchable,
 *           multi-select list of library clips plus an optional project name.
 * [POS]: The only door into a project. A recreation without a local source has nothing to read,
 *        so the dialog refuses to create a project until at least one clip is selected; the
 *        caller copies the chosen sources into `<project>/reference/`.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LibraryItemSummary } from '@remixclip/contracts';
import { Check, LoaderCircle, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useDownloads } from './DownloadsCenter';
import { getLibraryShots, listLibrary, mediaUrl, platformLabel } from '@/providers/library';
import { formatDuration } from '@/runtime/chat/format';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export interface NewProjectInput {
  /** Trimmed; empty means "name it after the first selected clip". */
  name: string;
  items: LibraryItemSummary[];
}

export function NewProjectDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  /** Rejects when the project could not be created; the dialog stays open and shows the reason. */
  onCreate: (input: NewProjectInput) => Promise<void>;
}) {
  const { t } = useI18n();
  const { start } = useDownloads();
  const [items, setItems] = useState<LibraryItemSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The library can change between openings, so every open reloads instead of trusting a cache.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setError('');
    void listLibrary({ platform: 'all', limit: 200 })
      .then((response) => { if (!cancelled) setItems(response.items); })
      .catch((reason: unknown) => {
        if (!cancelled) setLoadError(reason instanceof Error ? reason.message : t('errors.libraryRead'));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `t` is stable per locale; reloading on locale change would discard the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) => item.title.toLocaleLowerCase().includes(needle));
  }, [items, query]);

  const selectedItems = useMemo(
    () => selected.map((id) => items.find((item) => item.id === id)).filter((item): item is LibraryItemSummary => Boolean(item)),
    [items, selected],
  );

  const toggle = (id: string) => {
    setSelected((previous) => (previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id]));
  };

  const reset = () => {
    setQuery('');
    setName('');
    setSelected([]);
    setBusy(false);
    setError('');
  };

  const close = () => {
    if (busy) return;
    reset();
    onClose();
  };

  /**
   * A source that is not on disk cannot be copied into `reference/`, so the dialog finishes the
   * downloads it started and only then creates the project. `start` is idempotent: a clip already
   * downloading elsewhere simply joins that download.
   */
  const ensureLocal = async (item: LibraryItemSummary): Promise<boolean> => {
    const status = async () => (await getLibraryShots(item.id).catch(() => null))?.media?.status ?? null;
    if (await status() === 'ready') return true;
    await start(item.id).catch(() => undefined);
    return await status() === 'ready';
  };

  const create = async () => {
    if (!selectedItems.length || busy) return;
    setBusy(true);
    setError('');
    try {
      const ready = await Promise.all(selectedItems.map(ensureLocal));
      const failed = ready.filter((value) => !value).length;
      if (failed) {
        setError(t('library.pickDownloadFailed', { count: String(failed) }));
        return;
      }
      await onCreate({ name: name.trim(), items: selectedItems });
      reset();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('errors.createProject'));
    } finally {
      setBusy(false);
    }
  };

  const required = selectedItems.length === 0;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="flex max-h-[84vh] w-[460px] flex-col overflow-hidden sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('sidebar.newProject')}</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {t('sidebar.newProjectDesc')}
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={name}
          placeholder={t('sidebar.projectNamePlaceholder')}
          aria-label={t('sidebar.projectNameAria')}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === 'Enter' && !required) { event.preventDefault(); void create(); }
          }}
        />

        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            placeholder={t('library.pickSearch')}
            aria-label={t('library.pickSearch')}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8 text-[13px]"
          />
        </div>

        <div className="-mr-1 min-h-[180px] flex-1 overflow-y-auto pr-1 scrollbar-thin" role="listbox" aria-multiselectable="true" aria-label={t('library.pickTitle')}>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              {t('library.loading')}
            </div>
          ) : loadError ? (
            <p role="alert" className="px-2 py-10 text-center text-[12.5px] text-status-interrupted">{loadError}</p>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-10 text-center text-[12.5px] text-muted-foreground">{t('library.pickEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((item) => {
                const active = selected.includes(item.id);
                const cover = mediaUrl(item.coverUrl);
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      disabled={busy}
                      onClick={() => toggle(item.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-left transition-colors',
                        active ? 'border-primary/60 bg-primary/5' : 'border-transparent hover:bg-secondary/60',
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                          active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background',
                        )}
                      >
                        {active && <Check className="size-3" />}
                      </span>
                      <span className="block h-11 w-[62px] shrink-0 overflow-hidden rounded bg-secondary">
                        {cover ? (
                          <img src={cover} alt="" className="size-full object-cover" loading="lazy" />
                        ) : (
                          <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">{platformLabel(item.platform)}</span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-foreground">{item.title || t('library.untitled')}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {platformLabel(item.platform)}
                          {item.duration ? ` · ${formatDuration(item.duration)}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className={cn('text-[11.5px] leading-4', required ? 'text-muted-foreground' : 'text-foreground/70')}>
          {required ? t('sidebar.createNeedsMaterial') : t('library.pickDesc')}
        </p>
        {error && <p role="alert" className="text-[11.5px] leading-4 text-status-interrupted">{error}</p>}

        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={close} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={required || busy || loading} onClick={() => void create()}>
            {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {busy ? t('library.pickPreparing') : required ? t('common.create') : t('library.pickConfirm', { count: String(selectedItems.length) })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
