'use client';

/**
 * [INPUT]: GET /api/cuts — every project that has a finished cut (`output/final.mp4`).
 * [OUTPUT]: 成片库: a grid of cuts with poster, duration and project name, a preview dialog and
 *           a shortcut back into the project that produced the cut.
 * [POS]: The output-side destination in the sidebar. It is read-only by design — a cut is always
 *        produced by a project, so there is no "new cut" action here.
 */
import { useCallback, useEffect, useState, type RefObject } from 'react';
import type { ProjectCut } from '@remixclip/contracts';
import { Clapperboard, ExternalLink, LoaderCircle, PanelLeftOpen, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DownloadsButton } from '@/components/library/DownloadsCenter';
import { ArtifactPreviewDialog } from '@/components/chat/ArtifactPreviewDialog';
import { artifactFileUrl, formatSize } from '@/components/chat/chat-types';
import { formatDuration } from '@/runtime/chat/format';
import { listCuts } from '@/providers/cuts';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Last successful response, kept across mounts: switching tabs remounts the pane, and re-showing
 * a full skeleton every time is exactly the flicker the chat pane had. Cards paint from here
 * while the refresh runs in the background.
 */
let cutsSnapshot: ProjectCut[] | null = null;

export interface CutsPaneProps {
  sidebarCollapsed: boolean;
  sidebarCompact: boolean;
  sidebarDrawerOpen: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarDrawerOpen: (open: boolean) => void;
  sidebarToggleRef: RefObject<HTMLButtonElement>;
  sidebarSearchToggleRef: RefObject<HTMLButtonElement>;
  /** Jumps to the project that produced the cut (its chat is where the work continues). */
  onOpenProject: (projectId: string) => void;
}

export function CutsPane({
  sidebarCollapsed,
  sidebarCompact,
  sidebarDrawerOpen,
  setSidebarCollapsed,
  setSidebarDrawerOpen,
  sidebarToggleRef,
  sidebarSearchToggleRef,
  onOpenProject,
}: CutsPaneProps) {
  const { t, locale } = useI18n();
  const [cuts, setCuts] = useState<ProjectCut[]>(() => cutsSnapshot ?? []);
  // Only a cold first open shows the skeleton; a remount paints the cached grid immediately.
  const [loading, setLoading] = useState(() => cutsSnapshot === null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<ProjectCut | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const next = await listCuts();
      cutsSnapshot = next;
      setCuts(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('errors.cutsRead'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
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
          {t('tabs.cuts')}
          {cuts.length > 0 && <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">{cuts.length}</span>}
        </h3>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('cuts.refresh')}
                title={t('cuts.refresh')}
                className="text-muted-foreground hover:text-foreground"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw className={cn('size-4', loading && 'animate-spin')} aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('cuts.refresh')}</TooltipContent>
          </Tooltip>
          <DownloadsButton />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-6 scrollbar-thin">
        {loading && cuts.length === 0 ? (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="overflow-hidden rounded-xl border border-border/70 bg-card">
                <div className="aspect-video animate-pulse bg-secondary/70" />
                <div className="space-y-2 px-3 py-3">
                  <div className="h-3 w-2/3 animate-pulse rounded bg-secondary" />
                  <div className="h-2.5 w-1/3 animate-pulse rounded bg-secondary/70" />
                </div>
              </div>
            ))}
          </div>
        ) : error && cuts.length === 0 ? (
          <div role="alert" className="flex flex-col items-center gap-3 px-4 py-16 text-center text-[13px] text-muted-foreground">
            <span>{error}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {t('common.retry')}
            </Button>
          </div>
        ) : cuts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-20 text-center">
            <Clapperboard className="size-9 text-muted-foreground/50" aria-hidden="true" />
            <h3 className="text-[14px] font-medium text-foreground">{t('cuts.emptyTitle')}</h3>
            <p className="max-w-[380px] text-[12.5px] leading-5 text-muted-foreground">{t('cuts.emptyDesc')}</p>
          </div>
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
            {cuts.map((cut) => (
              <CutCard
                key={cut.projectId}
                cut={cut}
                dateLabel={t('cuts.updatedAt', { date: dateFormat.format(new Date(cut.updatedAt)) })}
                previewLabel={t('cuts.preview', { name: cut.projectName })}
                openLabel={t('cuts.openProject')}
                onPreview={() => setPreview(cut)}
                onOpen={() => onOpenProject(cut.projectId)}
              />
            ))}
          </div>
        )}
      </div>

      <ArtifactPreviewDialog
        target={preview ? {
          conversationId: preview.conversationId,
          path: preview.outputPath,
          name: `${preview.projectName}.mp4`,
          size: preview.size,
          kind: 'video',
          mtimeMs: preview.updatedAt,
        } : null}
        onClose={() => setPreview(null)}
      />
    </div>
  );
}

function CutCard({
  cut,
  dateLabel,
  previewLabel,
  openLabel,
  onPreview,
  onOpen,
}: {
  cut: ProjectCut;
  dateLabel: string;
  previewLabel: string;
  openLabel: string;
  onPreview: () => void;
  onOpen: () => void;
}) {
  const [posterBroken, setPosterBroken] = useState(false);
  const posterUrl = cut.posterPath && !posterBroken
    ? artifactFileUrl(cut.conversationId, cut.posterPath, cut.updatedAt)
    : null;

  return (
    <article className="group overflow-hidden rounded-xl border border-border/70 bg-card transition-colors hover:border-border">
      <button
        type="button"
        onClick={onPreview}
        aria-label={previewLabel}
        className="relative block aspect-video w-full overflow-hidden bg-secondary/60"
      >
        {posterUrl ? (
          <img
            src={posterUrl}
            alt=""
            loading="lazy"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            onError={() => setPosterBroken(true)}
          />
        ) : (
          <span className="flex size-full items-center justify-center text-muted-foreground/60">
            <Clapperboard className="size-8" aria-hidden="true" />
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/20 group-hover:opacity-100">
          <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm">
            <Play className="size-4 translate-x-[1px]" aria-hidden="true" />
          </span>
        </span>
        {cut.durationMs ? (
          <span className="absolute right-2 bottom-2 rounded bg-black/65 px-1.5 py-0.5 text-[10.5px] tabular-nums text-white">
            {formatDuration(cut.durationMs / 1000)}
          </span>
        ) : null}
      </button>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-medium text-foreground" title={cut.projectName}>{cut.projectName}</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
            {dateLabel}
            <span className="mx-1 opacity-50">·</span>
            {formatSize(cut.size)}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 gap-1 text-muted-foreground hover:text-foreground"
          onClick={onOpen}
        >
          <ExternalLink className="size-3" aria-hidden="true" />
          {openLabel}
        </Button>
      </div>
    </article>
  );
}
