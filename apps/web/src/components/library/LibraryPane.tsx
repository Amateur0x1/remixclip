'use client';

/**
 * [INPUT]: Library list state, filters, pairing/import actions, and main-area title bar state.
 * [OUTPUT]: Library workspace (platform filters, search, cover grid, empty states, drag-and-drop import).
 * [POS]: Main view of the workspace "Library" tab; data comes from the social media extension.
 */
import { useMemo, useRef, useState } from 'react';
import type { SocialPlatform } from '@remixclip/contracts';
import {
  ArrowDownUp,
  Images,
  LoaderCircle,
  PanelLeftOpen,
  Plug,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type DictKey } from '@/i18n';
import { PLATFORM_META } from '@/providers/library';
import { cn } from '@/lib/utils';
import { LibraryConnectDialog } from './LibraryConnectDialog';
import { LibraryDetailDialog } from './LibraryDetailDialog';
import { LibraryImportDialog } from './LibraryImportDialog';
import { LibraryItemCard } from './LibraryItemCard';
import { useLibrary, type LibrarySort } from './useLibrary';

export interface LibraryPaneProps {
  sidebarCollapsed: boolean;
  sidebarCompact: boolean;
  sidebarDrawerOpen: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarDrawerOpen: (open: boolean) => void;
  sidebarToggleRef: React.RefObject<HTMLButtonElement>;
  sidebarSearchToggleRef: React.RefObject<HTMLButtonElement>;
}

const SORT_LABEL_KEY = {
  imported: 'library.sortImported',
  published: 'library.sortPublished',
  likes: 'library.sortLikes',
} as const satisfies Record<LibrarySort, DictKey>;

export function LibraryPane({
  sidebarCollapsed,
  sidebarCompact,
  sidebarDrawerOpen,
  setSidebarCollapsed,
  setSidebarDrawerOpen,
  sidebarToggleRef,
  sidebarSearchToggleRef,
}: LibraryPaneProps) {
  const { t } = useI18n();
  const lib = useLibrary();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const selectedSummary = useMemo(
    () => lib.items.find((item) => item.id === selectedId) ?? null,
    [lib.items, selectedId],
  );

  const platformOptions = useMemo(() => ([
    { key: 'all' as const, label: t('library.allPlatforms'), count: lib.counts.all },
    ...(Object.keys(PLATFORM_META) as SocialPlatform[]).map((key) => ({
      key,
      label: t(PLATFORM_META[key].labelKey),
      count: lib.counts[key],
    })),
  ]), [lib.counts, t]);

  const pickFile = (file: File | null | undefined) => {
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      lib.setNotice(t('library.pickJson'));
      return;
    }
    setImportFile(file);
  };

  const onboarding = lib.counts.all === 0 && !lib.query && lib.platform === 'all' && !lib.loading;

  return (
    <div
      className="relative flex h-full min-h-0 min-w-0 flex-col"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        pickFile(event.dataTransfer.files[0]);
      }}
    >
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

        <h3 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-foreground">
          {t('tabs.library')}
          {lib.total > 0 && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{lib.total}</span>}
        </h3>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('library.connectAria')}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setConnectOpen(true)}
              >
                <Plug className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('library.connect.title')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('library.importAria')}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('library.importTitle')}</TooltipContent>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('library.moreAria')}
                className="text-muted-foreground hover:text-foreground"
                disabled={lib.counts.all === 0}
              >
                <ArrowDownUp className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onSelect={() => setConfirmClear(true)}>
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t('library.clearAll')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              pickFile(event.target.files?.[0]);
              event.target.value = '';
            }}
          />
        </div>
      </header>

      {/* Filters and search */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pb-3 pt-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {platformOptions.map((option) => {
            const active = lib.platform === option.key;
            return (
              <button
                key={option.key}
                type="button"
                onClick={() => lib.setPlatform(option.key)}
                className={cn(
                  'flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] outline-none transition-colors',
                  active ? 'bg-foreground text-background' : 'bg-secondary/70 text-muted-foreground hover:text-foreground',
                )}
              >
                {option.key !== 'all' && (
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: PLATFORM_META[option.key].color }}
                    aria-hidden="true"
                  />
                )}
                {option.label}
                <span className={cn('tabular-nums', active ? 'text-background/65' : 'text-muted-foreground/70')}>{option.count}</span>
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-8 w-40 items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2.5 transition-colors focus-within:border-gray-500 sm:w-52">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              value={lib.query}
              onChange={(event) => lib.setQuery(event.target.value)}
              placeholder={t('library.searchPlaceholder')}
              aria-label={t('library.searchAria')}
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <Select value={lib.sort} onValueChange={(value) => lib.setSort(value as LibrarySort)}>
            <SelectTrigger size="sm" className="h-8 w-[104px] gap-1 border-border/70 bg-background/60 px-2 text-[12px]" aria-label={t('library.sortAria')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {(Object.keys(SORT_LABEL_KEY) as LibrarySort[]).map((key) => (
                <SelectItem key={key} value={key} className="text-[12.5px]">{t(SORT_LABEL_KEY[key])}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Silent refresh bar: always holds a 2px slot; fades in only after 150ms, so
          an instant local round-trip shows nothing at all */}
      <div aria-hidden="true" className="h-0.5 shrink-0 overflow-hidden">
        <div
          className={cn(
            'h-full w-full bg-foreground/20 transition-opacity duration-200',
            lib.refreshing ? 'animate-pulse opacity-100 delay-150' : 'opacity-0 delay-0',
          )}
        />
      </div>

      {(lib.notice || lib.error || confirmClear) && (
        <div className="shrink-0 px-4 pb-2">
          {confirmClear ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-secondary/60 px-3 py-2 text-[12px]">
              <span>{t('library.confirmClear', { count: lib.counts.all })}</span>
              <div className="ml-auto flex items-center gap-1">
                <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmClear(false)}>{t('common.cancel')}</Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="xs"
                  onClick={() => { setConfirmClear(false); void lib.clearAll(); }}
                >
                  {t('common.clear')}
                </Button>
              </div>
            </div>
          ) : lib.error ? (
            <div role="alert" className="flex items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-[12px]">
              {lib.error}
              <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => void lib.refresh()}>{t('common.retry')}</Button>
            </div>
          ) : (
            <p role="status" className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden="true" />
              {lib.notice}
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 [scrollbar-width:thin]">
        {lib.loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-5 pt-1">
            {Array.from({ length: 12 }).map((_, index) => (
              <div key={index} className="animate-pulse">
                <div className="aspect-[3/4] rounded-xl bg-secondary/70" />
                <div className="mt-2 h-3 w-5/6 rounded bg-secondary/70" />
                <div className="mt-1.5 h-2.5 w-1/2 rounded bg-secondary/50" />
              </div>
            ))}
          </div>
        ) : onboarding ? (
          <div className="mx-auto flex max-w-[520px] flex-col items-center px-4 py-14 text-center">
            <div className="relative mb-5 grid size-16 place-items-center rounded-2xl bg-secondary">
              <Images className="size-7 text-foreground/70" aria-hidden="true" />
              <span className="absolute -right-1.5 -bottom-1.5 grid size-7 place-items-center rounded-full bg-background ring-1 ring-border">
                <Plug className="size-3.5 text-foreground/70" aria-hidden="true" />
              </span>
            </div>
            <h2 className="text-[19px] font-semibold tracking-tight text-foreground">{t('library.onboardingTitle')}</h2>
            <p className="mt-2 max-w-[420px] text-[13px] leading-6 text-muted-foreground">
              {t('library.onboardingDesc')}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <Button type="button" size="sm" className="gap-1.5" onClick={() => setConnectOpen(true)}>
                <Plug className="size-3.5" aria-hidden="true" />
                {t('library.connectAria')}
              </Button>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-3.5" aria-hidden="true" />
                {t('library.onboardingImport')}
              </Button>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground/70">{t('library.onboardingDragHint')}</p>

            <div className="mt-9 grid w-full gap-2 text-left sm:grid-cols-3">
              {[
                { step: '01', title: t('library.step1Title'), desc: t('library.step1Desc') },
                { step: '02', title: t('library.step2Title'), desc: t('library.step2Desc') },
                { step: '03', title: t('library.step3Title'), desc: t('library.step3Desc') },
              ].map((item) => (
                <div key={item.step} className="rounded-xl border border-border/60 bg-background/40 px-3 py-3">
                  <span className="font-mono text-[10px] text-muted-foreground/60">{item.step}</span>
                  <p className="mt-1 text-[12.5px] font-medium text-foreground/85">{item.title}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        ) : lib.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-20 text-center text-muted-foreground">
            <Search className="mb-3 size-6 opacity-50" aria-hidden="true" />
            <p className="text-[13px]">{t('library.emptyTitle')}</p>
            <p className="mt-1 text-[11.5px] text-muted-foreground/70">{t('library.emptyHint')}</p>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="mt-3"
              onClick={() => { lib.setQuery(''); lib.setPlatform('all'); }}
            >
              {t('library.clearFilters')}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-x-3 gap-y-5 pt-1">
              {lib.items.map((item) => (
                <LibraryItemCard key={item.id} item={item} onOpen={() => setSelectedId(item.id)} />
              ))}
            </div>
            {lib.hasMore && (
              <div className="mt-6 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={lib.loadingMore}
                  onClick={() => void lib.loadMore()}
                >
                  {lib.loadingMore && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
                  {lib.loadingMore ? t('library.loadingMore') : t('library.loadMore', { count: lib.total - lib.items.length })}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-foreground/30 bg-background/80 text-foreground backdrop-blur-sm">
          <Upload className="size-6" aria-hidden="true" />
          <p className="text-[13px] font-medium">{t('library.dropTitle')}</p>
          <p className="text-[11.5px] text-muted-foreground">{t('library.dropHint')}</p>
        </div>
      )}

      <LibraryConnectDialog open={connectOpen} onClose={() => setConnectOpen(false)} />
      <LibraryImportDialog
        file={importFile}
        onClose={() => setImportFile(null)}
        onImport={(payload) => lib.importPayload(payload)}
      />
      <LibraryDetailDialog
        itemId={selectedId}
        summary={selectedSummary}
        onClose={() => setSelectedId(null)}
        onDeleted={(id) => {
          setSelectedId(null);
          void lib.removeItem(id);
        }}
      />
    </div>
  );
}
