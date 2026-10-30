'use client';

/**
 * [INPUT]: One item summary and an open-detail callback.
 * [OUTPUT]: Library grid card (cover, platform, video badge, title, author, and engagement data).
 * [POS]: The visual unit of the library's first screen; covers all go through the daemon media proxy.
 */
import { ExternalLink, Heart, Play, StickyNote } from 'lucide-react';
import type { LibraryItemSummary } from '@remixclip/contracts';
import { mediaUrl, platformMeta } from '@/providers/library';
import { t, getLocale, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export function formatCount(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1).replace(/\.0$/, '')}${t('library.compactHundredMillion')}`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1).replace(/\.0$/, '')}${t('library.compactTenThousand')}`;
  return String(value);
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
  if (ms == null || ms < 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
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

export function LibraryItemCard({
  item,
  onOpen,
}: {
  item: LibraryItemSummary;
  onOpen: () => void;
}) {
  const { t: translate } = useI18n();
  const platform = platformMeta(item.platform);
  const cover = mediaUrl(item.coverUrl ?? item.images[0]);
  const isVideo = Boolean(item.videoUrl) || (item.duration ?? 0) > 0;
  const title = item.title || item.desc || translate('library.untitled');

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={translate('library.viewItemAria', { title })}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group flex min-w-0 cursor-pointer flex-col rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl bg-muted ring-1 ring-border/60">
        {cover ? (
          <img
            src={cover}
            alt=""
            loading="lazy"
            draggable={false}
            className="size-full object-cover transition duration-500 group-hover:scale-[1.035]"
            onError={(event) => { (event.currentTarget as HTMLImageElement).style.opacity = '0'; }}
          />
        ) : (
          <div className="flex size-full items-center justify-center bg-gradient-to-br from-secondary to-muted text-muted-foreground/50">
            {isVideo ? <Play className="size-8" /> : <StickyNote className="size-8" />}
          </div>
        )}

        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/45 to-transparent p-2 pb-8">
          <span className="inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-0.5 text-[10.5px] font-medium text-white backdrop-blur-sm">
            <span className="size-1.5 rounded-full" style={{ backgroundColor: platform.color }} aria-hidden="true" />
            {translate(platform.labelKey)}
          </span>
          <span className="inline-flex items-center gap-1">
            {isVideo && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                <Play className="size-2.5 fill-current" aria-hidden="true" />
                {item.duration ? `${Math.floor(item.duration / 60)}:${String(item.duration % 60).padStart(2, '0')}` : translate('library.video')}
              </span>
            )}
            {item.kind === 'card' && (
              <span className="rounded-full bg-black/45 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">{translate('library.card')}</span>
            )}
          </span>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/65 via-black/20 to-transparent p-2 pt-10">
          <span className="min-w-0 truncate text-[11px] text-white/85">
            {item.author?.name ? `@${item.author.name}` : translate('library.unknownAuthor')}
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-white/90">
            <Heart className="size-3 fill-current" aria-hidden="true" />
            {formatCount(item.metrics.likes)}
          </span>
        </div>

        {item.pageUrl && (
          <a
            href={item.pageUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={translate('library.openPost')}
            onClick={(event) => event.stopPropagation()}
            className={cn(
              'absolute right-2 bottom-2 flex size-7 items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm backdrop-blur-sm transition-opacity',
              'hover:bg-background focus-visible:opacity-100 group-hover:opacity-100',
            )}
          >
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </div>

      <div className="mt-2 min-w-0 px-0.5">
        <p className="line-clamp-2 text-[13px] font-medium leading-5 text-foreground/90">{title}</p>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{item.publishedAt ? formatPublishedAt(item.publishedAt) : translate('library.justImported')}</span>
          <span className="shrink-0">
            {item.capturedCommentCount > 0 ? translate('library.commentsCount', { count: item.capturedCommentCount }) : item.tags[0] ? `#${item.tags[0]}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}
