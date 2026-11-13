'use client';

/**
 * [INPUT]: One item summary, an open-detail callback, and the agent-handoff callback.
 * [OUTPUT]: Library grid card (cover at its true aspect ratio, platform, video badge, title,
 *           author, engagement data) with a primary-coloured 「复刻」 button on the cover, plus the
 *           shared cover-ratio helpers the masonry uses.
 * [POS]: The visual unit of the library's first screen; covers all go through the daemon media proxy.
 *        The replicate action lives on the cover instead of a right-click menu: a context menu hides
 *        the primary action behind a gesture most people never try. A single stretched overlay button
 *        opens the detail, so the cover pill and the post link stay real, plainly focusable controls
 *        instead of nested buttons inside a `role="button"` card.
 */
import { useState } from 'react';
import { ExternalLink, Heart, Play, Sparkles, StickyNote } from 'lucide-react';
import type { LibraryItemSummary } from '@remixclip/contracts';
import { mediaUrl, platformMeta } from '@/providers/library';
import { getLocale, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export function formatCount(value: number): string {
  // Compact notation follows the active locale: 12K in English, 1.2万 in Chinese.
  return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** Milliseconds → mm:ss (shared by the shot timeline / video metadata; adds hh: past one hour). */
export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '--:--';
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Seconds with one decimal, used to display shot durations. */
export function formatSeconds(ms?: number): string {
  if (ms == null || ms < 0) ms = 0;
  return new Intl.NumberFormat(getLocale(), {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ms / 1000);
}

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)}${units[unit]}`;
}

export function formatPublishedAt(value?: number): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(getLocale(), { year: 'numeric', month: 'numeric', day: 'numeric' });
}

/**
 * Covers keep their real aspect ratio, so heights are unknown until the browser reports the
 * natural size. Ratios are measured once per URL and remembered for the session: a re-mount
 * or the next page then starts at the right height instead of snapping from the fallback.
 */
const coverAspectCache = new Map<string, number>();

/** 3:4 is the most common note cover, used only until a real ratio is known. */
const FALLBACK_COVER_ASPECT = 3 / 4;
/** Clamp the extremes (tall screenshots / ultra-wide banners) so one item cannot dominate a column. */
const MIN_COVER_ASPECT = 0.5;
const MAX_COVER_ASPECT = 2.2;

function clampCoverAspect(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return FALLBACK_COVER_ASPECT;
  return Math.min(MAX_COVER_ASPECT, Math.max(MIN_COVER_ASPECT, value));
}

/**
 * Best ratio estimate before the image loads: the video's own dimensions, a ratio measured
 * earlier this session, or the 3:4 fallback. The masonry needs this to size columns up front.
 */
export function estimateCoverAspect(item: LibraryItemSummary): number {
  if (item.width && item.height) return clampCoverAspect(item.width / item.height);
  const cover = mediaUrl(item.coverUrl ?? item.images[0]);
  const cached = cover ? coverAspectCache.get(cover) : undefined;
  return cached ? clampCoverAspect(cached) : FALLBACK_COVER_ASPECT;
}

export function LibraryItemCard({
  item,
  onOpen,
  onReplicate,
}: {
  item: LibraryItemSummary;
  onOpen: () => void;
  /** Hand this item to the agent as a new conversation; the cover button is the only entry. */
  onReplicate?: () => void;
}) {
  const { t: translate } = useI18n();
  const platform = platformMeta(item.platform);
  const cover = mediaUrl(item.coverUrl ?? item.images[0]);
  const isVideo = Boolean(item.videoUrl) || (item.duration ?? 0) > 0;
  const title = item.title || item.desc || translate('library.untitled');
  const [aspect, setAspect] = useState(() => estimateCoverAspect(item));
  // A 16:9 cover is barely ~90px tall in a 178px column, so its gradients have to be tighter
  // than the ones a portrait cover can afford.
  const landscape = aspect >= 1.4;

  return (
    <div className="group relative flex min-w-0 flex-col rounded-xl">
      {/* One stretched control opens the detail; everything interactive sits above it. */}
      <button
        type="button"
        aria-label={translate('library.viewItemAria', { title })}
        onClick={onOpen}
        className="absolute inset-0 z-10 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      />
      <div
        className="relative overflow-hidden rounded-xl bg-muted ring-1 ring-border/60"
        style={{ aspectRatio: aspect }}
      >
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover transition duration-500 group-hover:scale-[1.035]"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (!image.naturalWidth || !image.naturalHeight) return;
              const next = clampCoverAspect(image.naturalWidth / image.naturalHeight);
              if (cover) coverAspectCache.set(cover, next);
              setAspect((current) => (Math.abs(current - next) < 0.005 ? current : next));
            }}
            onError={(event) => { (event.currentTarget as HTMLImageElement).style.opacity = '0'; }}
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-secondary to-muted text-muted-foreground/50">
            {isVideo ? <Play className="size-8" /> : <StickyNote className="size-8" />}
          </div>
        )}

        <div
          className={cn(
            'pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/45 to-transparent p-2',
            landscape ? 'pb-6' : 'pb-8',
          )}
        >
          <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: platform.color }} aria-hidden="true" />
            {translate(platform.labelKey)}
          </span>
          <span className="inline-flex items-center gap-1">
            {isVideo && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                <Play className="size-2.5 fill-current" aria-hidden="true" />
                {item.duration ? formatDuration(item.duration * 1000) : translate('library.video')}
              </span>
            )}
            {item.kind === 'card' && (
              <span className="rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">{translate('library.card')}</span>
            )}
          </span>
        </div>

        <div
          className={cn(
            'absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 via-black/25 to-transparent p-2',
            landscape ? 'pt-6' : 'pt-10',
          )}
        >
          <span className="pointer-events-none min-w-0 flex-1 truncate text-[11px] text-white/85">
            {item.author?.name ? `@${item.author.name}` : translate('library.unknownAuthor')}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="pointer-events-none flex items-center gap-1 text-[11px] text-white/90">
              <Heart className="size-3 fill-current" aria-hidden="true" />
              {formatCount(item.metrics.likes)}
            </span>
            {onReplicate && (
              <button
                type="button"
                aria-label={translate('library.replicateWithAi')}
                title={translate('library.replicateWithAi')}
                onClick={(event) => {
                  // The stretched overlay opens the detail; the button must not do both.
                  event.stopPropagation();
                  onReplicate();
                }}
                className="pointer-events-auto relative z-20 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground shadow-[0_2px_10px_rgb(0_0_0_/_0.45)] ring-1 ring-white/35 outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black/40"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                {translate('library.replicateAction')}
              </button>
            )}
          </span>
        </div>

      </div>

      <div className="relative mt-2 min-w-0 px-0.5">
        <p className="line-clamp-2 text-[13px] font-medium leading-5 text-foreground/90">{title}</p>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{item.publishedAt ? formatPublishedAt(item.publishedAt) : translate('library.justImported')}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <span className="truncate">
              {item.capturedCommentCount > 0 ? translate('library.commentsCount', { count: item.capturedCommentCount }) : item.tags[0] ? `#${item.tags[0]}` : ''}
            </span>
            {/* Lives next to the metadata rather than on the cover: with real aspect ratios a
                landscape cover is only ~90px tall and a floating button hid the like count. */}
            {item.pageUrl && (
              <a
                href={item.pageUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={translate('library.openPost')}
                onClick={(event) => event.stopPropagation()}
                className="relative z-20 flex size-4 items-center justify-center rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              >
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
