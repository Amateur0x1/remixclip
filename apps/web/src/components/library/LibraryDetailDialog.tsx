'use client';

/**
 * [INPUT]: Library item id, list summary, and delete callback.
 * [OUTPUT]: Library detail dialog: media preview / shot timeline / pixel-check views + download, shot
 *   analysis, render upload, and check actions.
 * [POS]: Deep-read view of the library; the left side offers three ways to look at the footage, the
 *   right side holds item info and the render pipeline.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryItem, LibraryItemSummary } from '@remixclip/contracts';
import {
  Check,
  Download,
  ExternalLink,
  Film,
  Heart,
  Layers,
  Link2,
  LoaderCircle,
  MessageCircle,
  Play,
  ScanLine,
  Share2,
  Sparkles,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getLibraryItem, localMediaUrl, mediaUrl, platformMeta } from '@/providers/library';
import { openExternalUrl } from '@/providers/daemon';
import { getLocale, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatBytes, formatCount, formatDuration, formatPublishedAt, formatSeconds } from './LibraryItemCard';
import { ShotTimeline } from './ShotTimeline';
import { COMPARISON_STATUS_META, ComparisonBoard, scoreTone } from './ComparisonBoard';
import { useMediaPipeline } from './useMediaPipeline';

type DetailItem = LibraryItem | LibraryItemSummary;
type LeftTab = 'preview' | 'shots' | 'compare';

function isFullItem(item: DetailItem | null): item is LibraryItem & { comments: NonNullable<LibraryItem['comments']> } {
  return Boolean(item) && Array.isArray((item as LibraryItem).comments);
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function LibraryDetailDialog({
  itemId,
  summary,
  onClose,
  onDeleted,
}: {
  itemId: string | null;
  summary?: LibraryItemSummary | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const { t } = useI18n();
  const [item, setItem] = useState<DetailItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeImage, setActiveImage] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState<'text' | 'link' | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>('preview');
  const [activeShotIndex, setActiveShotIndex] = useState<number | null>(null);
  const [selectedRenderId, setSelectedRenderId] = useState<string>('');
  const uploadRef = useRef<HTMLInputElement>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const pipeline = useMediaPipeline(itemId);
  const {
    source, renders, shots, shotJob, analyzing, downloading, comparing,
    comparisons, activeComparison, setActiveComparisonId, busy,
    download, analyze, uploadRender, compare, error: pipelineError, notice,
  } = pipeline;

  useEffect(() => {
    if (!itemId) {
      setItem(null);
      setError('');
      return;
    }
    setItem(summary ?? null);
    setActiveImage(0);
    setConfirmDelete(false);
    setLeftTab('preview');
    setActiveShotIndex(null);
    setSelectedRenderId('');
    setLoading(true);
    setError('');
    let cancelled = false;
    void getLibraryItem(itemId)
      .then((next) => { if (!cancelled) setItem(next); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : tRef.current('errors.libraryDetailRead')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [itemId, summary]);

  // Keep the selection valid when the render list changes (auto-select after first upload).
  useEffect(() => {
    if (renders.length === 0) {
      if (selectedRenderId) setSelectedRenderId('');
      return;
    }
    if (!renders.some((entry) => entry.id === selectedRenderId)) {
      setSelectedRenderId(renders[0].id);
    }
  }, [renders, selectedRenderId]);

  // Re-sync the highlighted shot when shots change, so re-analysis doesn't stay on an old index.
  useEffect(() => {
    if (shots.length === 0) {
      setActiveShotIndex(null);
      return;
    }
    if (!shots.some((shot) => shot.index === activeShotIndex)) {
      setActiveShotIndex(shots[0].index);
    }
  }, [shots, activeShotIndex]);

  // Auto-switch to the shot view once analysis finishes, saving a click.
  const wasAnalyzing = useRef(false);
  useEffect(() => {
    if (wasAnalyzing.current && !analyzing && shots.length > 0) setLeftTab('shots');
    wasAnalyzing.current = analyzing;
  }, [analyzing, shots.length]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const platform = item ? platformMeta(item.platform) : null;
  const images = useMemo(() => {
    if (!item) return [];
    const list = item.images.length > 0 ? item.images : item.coverUrl ? [item.coverUrl] : [];
    return Array.from(new Set(list));
  }, [item]);
  const activeUrl = mediaUrl(images[activeImage] ?? images[0] ?? item?.coverUrl);
  // Prefer the local source: remote direct links expire, only the persisted file is the
  // baseline for analysis / comparison.
  const videoUrl = source?.status === 'ready' ? localMediaUrl(source.path) : mediaUrl(item?.videoUrl);
  const activeShot = useMemo(
    () => shots.find((shot) => shot.index === activeShotIndex) ?? shots[0] ?? null,
    [shots, activeShotIndex],
  );
  const selectedRender = renders.find((entry) => entry.id === selectedRenderId) ?? null;
  const canAnalyze = source?.status === 'ready' && !analyzing && busy === null;
  const canCompare = Boolean(source?.status === 'ready') && shots.length > 0 && Boolean(selectedRender) && !comparing && busy === null;

  const copy = async (kind: 'text' | 'link') => {
    if (!item) return;
    const text = kind === 'link'
      ? item.pageUrl ?? ''
      : [item.title, item.desc, item.tags.map((tag) => `#${tag}`).join(' ')].filter(Boolean).join('\n\n');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      setError(t('library.copyFailed'));
    }
  };

  const runCompare = useCallback(async () => {
    if (!selectedRenderId) return;
    await compare(selectedRenderId);
    setLeftTab('compare');
  }, [compare, selectedRenderId]);

  const onUpload = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const uploaded = await uploadRender(file);
    if (uploaded) {
      setSelectedRenderId(uploaded.id);
      setLeftTab('compare');
    }
  }, [uploadRender]);

  const tabs: { key: LeftTab; label: string; count?: number; disabled?: boolean }[] = [
    { key: 'preview', label: t('library.tabPreview') },
    { key: 'shots', label: t('library.tabShots'), count: shots.length || undefined, disabled: shots.length === 0 },
    { key: 'compare', label: t('library.tabCompare'), disabled: comparisons.length === 0 },
  ];

  const pipelineBusy = busy !== null;

  return (
    <Dialog open={Boolean(itemId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {itemId && (
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(90vh,860px)] w-[min(96vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          <DialogTitle className="sr-only">{item?.title || t('library.detailTitle')}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('library.detailDesc')}
          </DialogDescription>

          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
            {platform && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[11.5px] text-foreground/80">
                <span className="size-1.5 rounded-full" style={{ backgroundColor: platform.color }} aria-hidden="true" />
                {t(platform.labelKey)}
              </span>
            )}
            <span className="truncate text-[12px] text-muted-foreground">
              {item?.author?.name ? `@${item.author.name}` : t('library.unknownAuthor')}
              {item?.publishedAt ? ` · ${formatPublishedAt(item.publishedAt)}` : ''}
              {item?.ipLocation ? ` · ${item.ipLocation}` : ''}
            </span>
            {(loading || pipeline.loading) && (
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-label={t('library.loading')} />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="ml-auto text-muted-foreground"
              aria-label={t('library.closeDetail')}
              onClick={onClose}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] md:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
            {/* Media area */}
            <div className="flex min-h-0 min-w-0 flex-col bg-[#111214]">
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-white/10 px-3">
                {tabs.map((tab) => {
                  const active = leftTab === tab.key;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      aria-current={active}
                      disabled={tab.disabled}
                      onClick={() => setLeftTab(tab.key)}
                      className={cn(
                        'flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] transition-colors',
                        active ? 'bg-white/12 text-white' : 'text-white/50 hover:text-white/80',
                        tab.disabled && 'pointer-events-none opacity-35',
                      )}
                    >
                      {tab.label}
                      {tab.count != null && <span className="tabular-nums text-white/40">{tab.count}</span>}
                    </button>
                  );
                })}
                {source?.status === 'ready' && (
                  <span className="ml-auto truncate pl-2 text-[10.5px] tabular-nums text-white/35">
                    {formatDuration(source.durationMs)}
                    {source.width && source.height ? ` · ${source.width}×${source.height}` : ''}
                    {source.bytes ? ` · ${formatBytes(source.bytes)}` : ''}
                  </span>
                )}
              </div>

              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden p-3">
                {leftTab === 'preview' && (
                  videoUrl ? (
                    <video
                      key={videoUrl}
                      src={videoUrl}
                      poster={mediaUrl(item?.coverUrl ?? images[0])}
                      controls
                      playsInline
                      className="m-auto max-h-full max-w-full rounded-lg bg-black"
                    />
                  ) : activeUrl ? (
                    <img
                      src={activeUrl}
                      alt={item?.title || t('library.mediaAlt')}
                      className="m-auto max-h-full max-w-full rounded-lg object-contain"
                      onError={() => setError(t('library.imageLoadFailed'))}
                    />
                  ) : (
                    <div className="m-auto flex flex-col items-center gap-2 text-white/45">
                      <Play className="size-10" aria-hidden="true" />
                      <span className="text-xs">{t('library.noPreviewMedia')}</span>
                    </div>
                  )
                )}

                {leftTab === 'shots' && (
                  shots.length === 0 ? (
                    <div className="m-auto flex flex-col items-center gap-2 px-6 text-center text-white/45">
                      <Film className="size-8" aria-hidden="true" />
                      <p className="text-[12.5px]">
                        {analyzing ? t('library.splitFrames') : t('library.noShots')}
                      </p>
                      <p className="text-[11px] text-white/30">
                        {source?.status === 'ready' ? t('library.startShotsHint') : t('library.downloadFirstHint')}
                      </p>
                      {source?.status === 'ready' && !analyzing && (
                        <Button type="button" size="sm" variant="secondary" className="mt-1 gap-1.5" onClick={() => void analyze()}>
                          <ScanLine className="size-3.5" aria-hidden="true" />
                          {t('library.startShots')}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-3">
                      <div className="flex min-h-0 flex-1 items-center justify-center">
                        <img
                          src={localMediaUrl(activeShot?.thumbnailPath)}
                          alt={t('library.shotAlt', { index: (activeShot?.index ?? 0) + 1 })}
                          className="max-h-full max-w-full rounded-lg object-contain"
                        />
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-[11px] text-white/50">
                        <span className="rounded bg-white/10 px-1.5 py-0.5 tabular-nums text-white/80">
                          {t('library.shotCounter', {
                            current: String((activeShot?.index ?? 0) + 1).padStart(2, '0'),
                            total: shots.length,
                          })}
                        </span>
                        <span className="tabular-nums">
                          {formatSeconds(activeShot?.startMs)} – {formatSeconds(activeShot?.endMs)}
                        </span>
                        <span className="ml-auto text-white/30">{t('library.switchShotHint')}</span>
                      </div>
                      <div className="shrink-0">
                        <ShotTimeline
                          shots={shots}
                          activeIndex={activeShot?.index ?? null}
                          onSelect={(shot) => setActiveShotIndex(shot.index)}
                        />
                      </div>
                    </div>
                  )
                )}

                {leftTab === 'compare' && (
                  activeComparison ? (
                    <ComparisonBoard
                      comparison={activeComparison}
                      activeShotIndex={activeShotIndex}
                      onSelectShot={setActiveShotIndex}
                    />
                  ) : (
                    <div className="m-auto flex flex-col items-center gap-2 px-6 text-center text-white/45">
                      <Sparkles className="size-8" aria-hidden="true" />
                      <p className="text-[12.5px]">{t('library.noComparison')}</p>
                      <p className="text-[11px] text-white/30">{t('library.compareHint')}</p>
                    </div>
                  )
                )}
              </div>

              {leftTab === 'preview' && !videoUrl && images.length > 1 && (
                <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 pb-3">
                  {images.map((image, index) => (
                    <button
                      key={`${image}-${index}`}
                      type="button"
                      aria-label={t('library.viewImageAria', { index: index + 1 })}
                      aria-current={index === activeImage}
                      onClick={() => setActiveImage(index)}
                      className={cn(
                        'size-12 shrink-0 overflow-hidden rounded-md ring-1 ring-white/15 transition-opacity',
                        index === activeImage ? 'opacity-100 ring-2 ring-white/80' : 'opacity-55 hover:opacity-90',
                      )}
                    >
                      <img src={mediaUrl(image)} alt="" className="size-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Info area */}
            <div className="flex min-h-0 min-w-0 flex-col border-l border-border/70">
              <div className="shrink-0 border-b border-border/70 px-5 py-3.5">
                <h2 className="text-[16px] font-semibold leading-6 text-foreground">
                  {item?.title || item?.desc?.slice(0, 80) || t('library.untitled')}
                </h2>
                <div className="mt-1.5 flex items-center gap-3 text-[11.5px] text-muted-foreground">
                  {item?.author?.name && <span>@{item.author.name}</span>}
                  {item?.kind === 'card' && <span>{t('library.cardOnly')}</span>}
                  {item?.source && <span>{t('library.sourceFrom', { source: item.source })}</span>}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]">
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { icon: Heart, label: t('library.metricLikes'), value: item?.metrics.likes ?? 0 },
                    { icon: Star, label: t('library.metricCollects'), value: item?.metrics.collects ?? 0 },
                    { icon: MessageCircle, label: t('library.metricComments'), value: item?.metrics.comments ?? 0 },
                    { icon: Share2, label: t('library.metricShares'), value: item?.metrics.shares ?? 0 },
                  ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className="rounded-lg bg-secondary/60 px-2.5 py-2">
                      <div className="flex items-center gap-1 text-[10.5px] text-muted-foreground">
                        <Icon className="size-3" aria-hidden="true" />
                        {label}
                      </div>
                      <p className="mt-0.5 text-[14px] font-semibold text-foreground">{formatCount(value)}</p>
                    </div>
                  ))}
                </div>

                {/* Render pipeline */}
                <section className="mt-4 overflow-hidden rounded-xl border border-border/70">
                  <div className="flex items-center gap-1.5 border-b border-border/60 bg-secondary/40 px-3 py-2">
                    <Layers className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <h3 className="text-[12px] font-medium text-foreground/85">{t('library.pipeline')}</h3>
                    <span className="ml-auto text-[10.5px] text-muted-foreground/70">{t('library.pipelineSteps')}</span>
                  </div>

                  <div className="flex flex-col gap-2.5 p-3">
                    {/* Source clip */}
                    <div className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{t('library.rowSource')}</span>
                      <div className="min-w-0 flex-1">
                        {source?.status === 'ready' ? (
                          <p className="flex items-center gap-1 truncate text-[11.5px] text-foreground/80">
                            <Check className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
                            {t('library.savedLocally', { duration: formatDuration(source.durationMs) })}
                            {source.bytes ? ` · ${formatBytes(source.bytes)}` : ''}
                          </p>
                        ) : downloading ? (
                          <div className="flex flex-col gap-1">
                            <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
                              <div
                                className="h-full rounded-full bg-foreground/60 transition-[width]"
                                style={{ width: `${Math.round((source?.progress ?? 0) * 100)}%` }}
                              />
                            </div>
                            <span className="text-[10.5px] text-muted-foreground">
                              {source?.status === 'pending' ? t('library.queued') : t('library.downloading', { percent: Math.round((source?.progress ?? 0) * 100) })}
                            </span>
                          </div>
                        ) : source?.status === 'failed' ? (
                          <p className="truncate text-[11.5px] text-destructive" title={source.error}>
                            {source.error ?? t('library.downloadFailed')}
                          </p>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground">{t('library.notDownloaded')}</p>
                        )}
                      </div>
                      {source?.status !== 'ready' && (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="shrink-0 gap-1"
                          disabled={downloading || pipelineBusy}
                          onClick={() => void download()}
                        >
                          {downloading ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <Download className="size-3" aria-hidden="true" />}
                          {source?.status === 'failed' ? t('common.retry') : t('library.download')}
                        </Button>
                      )}
                    </div>

                    {/* Shot analysis */}
                    <div className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{t('library.rowShots')}</span>
                      <div className="min-w-0 flex-1 text-[11.5px]">
                        {analyzing ? (
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                            {t('library.splitFramesShort')}
                          </span>
                        ) : shots.length > 0 ? (
                          <button
                            type="button"
                            onClick={() => setLeftTab('shots')}
                            className="text-foreground/80 underline-offset-2 hover:underline"
                          >
                            {t('library.shotsLink', { count: shots.length })}
                          </button>
                        ) : shotJob?.status === 'failed' ? (
                          <span className="text-destructive">{shotJob.error ?? t('library.shotsFailed')}</span>
                        ) : (
                          <span className="text-muted-foreground">{t('library.notAnalyzed')}</span>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant={shots.length > 0 ? 'ghost' : 'outline'}
                        size="xs"
                        className="shrink-0 gap-1"
                        disabled={!canAnalyze}
                        onClick={() => { setLeftTab('shots'); void analyze(); }}
                      >
                        {analyzing ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <ScanLine className="size-3" aria-hidden="true" />}
                        {shots.length > 0 ? t('library.reanalyze') : t('library.startShots')}
                      </Button>
                    </div>

                    {/* Renders */}
                    <div className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{t('library.rowRender')}</span>
                      <div className="min-w-0 flex-1">
                        {renders.length > 0 ? (
                          <Select value={selectedRenderId} onValueChange={setSelectedRenderId}>
                            <SelectTrigger size="sm" className="h-7 w-full gap-1 border-border/70 bg-background/60 px-2 text-[11.5px]" aria-label={t('library.selectRender')}>
                              <SelectValue placeholder={t('library.selectRender')} />
                            </SelectTrigger>
                            <SelectContent align="end" className="max-w-[320px]">
                              {renders.map((render) => (
                                <SelectItem key={render.id} value={render.id} className="text-[12px]">
                                  <span className="block max-w-[260px] truncate">{fileName(render.path)}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground">{t('library.notUploaded')}</p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant={renders.length > 0 ? 'ghost' : 'outline'}
                        size="xs"
                        className="shrink-0 gap-1"
                        disabled={pipelineBusy}
                        onClick={() => uploadRef.current?.click()}
                      >
                        {busy === 'render' ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> : <Upload className="size-3" aria-hidden="true" />}
                        {renders.length > 0 ? t('library.uploadAnother') : t('library.upload')}
                      </Button>
                      <input
                        ref={uploadRef}
                        type="file"
                        accept="video/*,.mp4,.mov,.webm,.m4v"
                        className="hidden"
                        onChange={(event) => {
                          void onUpload(event.target.files?.[0]);
                          event.target.value = '';
                        }}
                      />
                    </div>

                    {/* Check */}
                    <div className="flex items-center gap-2">
                      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{t('library.rowCompare')}</span>
                      <div className="min-w-0 flex-1">
                        {activeComparison ? (
                          <button
                            type="button"
                            onClick={() => setLeftTab('compare')}
                            className="flex items-center gap-1.5 text-[11.5px]"
                          >
                            <span className={cn('size-1.5 rounded-full', COMPARISON_STATUS_META[activeComparison.status].dot)} aria-hidden="true" />
                            <span className={COMPARISON_STATUS_META[activeComparison.status].text}>
                              {t(COMPARISON_STATUS_META[activeComparison.status].labelKey)}
                            </span>
                            {activeComparison.status !== 'running' && (
                              <span className={cn('font-semibold tabular-nums', scoreTone(activeComparison.totalScore))}>
                                {(activeComparison.totalScore * 100).toFixed(1)}%
                              </span>
                            )}
                          </button>
                        ) : (
                          <p className="text-[11.5px] text-muted-foreground">
                            {shots.length === 0 ? t('library.needShotsFirst') : renders.length === 0 ? t('library.needRenderFirst') : t('library.notCompared')}
                          </p>
                        )}
                      </div>
                      <Button
                        type="button"
                        variant={comparisons.length > 0 ? 'ghost' : 'default'}
                        size="xs"
                        className="shrink-0 gap-1"
                        disabled={!canCompare}
                        onClick={() => void runCompare()}
                      >
                        {busy === 'compare' || comparing ? (
                          <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                        ) : (
                          <Sparkles className="size-3" aria-hidden="true" />
                        )}
                        {t('library.startCompare')}
                      </Button>
                    </div>

                    {(pipelineError || notice) && (
                      <p
                        role={pipelineError ? 'alert' : 'status'}
                        className={cn(
                          'rounded-md px-2 py-1 text-[11px]',
                          pipelineError ? 'bg-destructive/10 text-destructive' : 'bg-secondary/70 text-muted-foreground',
                        )}
                      >
                        {pipelineError || notice}
                      </p>
                    )}

                    {/* Check history */}
                    {comparisons.length > 0 && (
                      <div className="border-t border-border/60 pt-2">
                        <div className="mb-1 flex items-center justify-between text-[10.5px] text-muted-foreground">
                          <span>{t('library.recentComparisons')}</span>
                          <span className="tabular-nums">{t('library.keepRecent', { count: comparisons.length })}</span>
                        </div>
                        <ul className="flex flex-col gap-0.5">
                          {comparisons.map((entry) => {
                            const meta = COMPARISON_STATUS_META[entry.status];
                            const active = activeComparison?.id === entry.id;
                            return (
                              <li key={entry.id}>
                                <button
                                  type="button"
                                  onClick={() => { setActiveComparisonId(entry.id); setLeftTab('compare'); }}
                                  className={cn(
                                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] transition-colors',
                                    active ? 'bg-secondary' : 'hover:bg-secondary/60',
                                  )}
                                >
                                  <span className={cn('size-1.5 shrink-0 rounded-full', meta.dot)} aria-hidden="true" />
                                  <span className={cn('truncate', meta.text)}>{t(meta.labelKey)}</span>
                                  <span className="ml-auto shrink-0 tabular-nums text-foreground/80">
                                    {entry.status === 'running' ? '—' : `${(entry.totalScore * 100).toFixed(1)}%`}
                                  </span>
                                  <span className="shrink-0 tabular-nums text-muted-foreground/60">{formatClock(entry.createdAt)}</span>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                  </div>
                </section>

                {(item?.tags.length ?? 0) > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {item!.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">#{tag}</span>
                    ))}
                  </div>
                )}

                {item?.desc && (
                  <section className="mt-4">
                    <h3 className="mb-1.5 text-[12px] font-medium text-muted-foreground">{t('library.caption')}</h3>
                    <p className="whitespace-pre-wrap text-[13px] leading-6 text-foreground/85">{item.desc}</p>
                  </section>
                )}

                <section className="mt-5">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="text-[12px] font-medium text-muted-foreground">{t('library.capturedComments')}</h3>
                    <span className="text-[11px] text-muted-foreground/70">{t('library.commentsUnit', { count: item?.capturedCommentCount ?? 0 })}</span>
                  </div>
                  {!isFullItem(item) || item.comments.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                      {item?.kind === 'card' ? t('library.cardNoComments') : t('library.noComments')}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-3">
                      {item.comments.slice(0, 40).map((comment) => (
                        <li key={comment.id} className="border-b border-border/50 pb-3 last:border-0 last:pb-0">
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate font-medium text-foreground/70">{comment.author || t('library.anonymous')}</span>
                            {comment.ipLocation && <span className="shrink-0">{comment.ipLocation}</span>}
                            {comment.likes > 0 && (
                              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                                <Heart className="size-2.5" aria-hidden="true" />
                                {formatCount(comment.likes)}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[12.5px] leading-5 text-foreground/80">{comment.text}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {error && <p role="alert" className="mt-4 rounded-md bg-secondary px-3 py-2 text-[12px] text-foreground">{error}</p>}
              </div>

              <div className="flex shrink-0 items-center gap-1.5 border-t border-border/70 px-3 py-2.5">
                <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => void copy('text')}>
                  {copied === 'text' ? t('common.copied') : t('library.copyCaption')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  aria-label={t('library.copyLinkAria')}
                  disabled={!item?.pageUrl}
                  onClick={() => void copy('link')}
                >
                  <Link2 className="size-3.5" aria-hidden="true" />
                </Button>
                {confirmDelete ? (
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[11.5px] text-muted-foreground">{t('library.confirmRemove')}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      onClick={() => { if (item) onDeleted(item.id); }}
                    >
                      {t('common.remove')}
                    </Button>
                  </div>
                ) : (
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={t('library.removeFromLibrary')}
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      disabled={!item?.pageUrl}
                      onClick={() => { if (item?.pageUrl) void openExternalUrl(item.pageUrl); }}
                    >
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                      {t('library.openPost')}
                    </Button>
                  </div>
                )}
              </div>
              {copied === 'link' && <span className="sr-only" role="status">{t('library.linkCopied')}</span>}
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
