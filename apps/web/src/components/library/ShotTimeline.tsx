'use client';

/**
 * [INPUT]: Shot list and the currently selected shot index.
 * [OUTPUT]: A duration-proportional time bar + a horizontally scrollable thumbnail card rail.
 * [POS]: Visual presentation of shot analysis results; clicking a shot hands it back to the detail
 *   dialog for an enlarged preview.
 */
import { useEffect, useRef } from 'react';
import type { Shot } from '@remixclip/contracts';
import { Film } from 'lucide-react';
import { localMediaUrl } from '@/providers/library';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatSeconds } from './LibraryItemCard';

export function ShotTimeline({
  shots,
  activeIndex,
  onSelect,
}: {
  shots: Shot[];
  activeIndex: number | null;
  onSelect: (shot: Shot) => void;
}) {
  const { t } = useI18n();
  const railRef = useRef<HTMLDivElement>(null);
  const total = shots.reduce((sum, shot) => sum + Math.max(1, shot.endMs - shot.startMs), 0);

  // When the selection comes from outside (e.g. synced from comparison results), scroll the
  // matching thumbnail into view.
  useEffect(() => {
    if (activeIndex == null) return;
    const rail = railRef.current;
    const card = rail?.querySelector<HTMLElement>(`[data-shot-index="${activeIndex}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activeIndex]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-white/10" role="presentation">
        {shots.map((shot) => {
          const ratio = Math.max(1, shot.endMs - shot.startMs) / Math.max(1, total);
          const active = shot.index === activeIndex;
          return (
            <button
              key={shot.id}
              type="button"
              title={`${t('library.shotWord')} ${shot.index + 1} · ${formatSeconds(shot.endMs - shot.startMs)}`}
              aria-label={t('library.shotAlt', { index: shot.index + 1 })}
              onClick={() => onSelect(shot)}
              style={{ width: `${ratio * 100}%` }}
              className={cn(
                'h-full min-w-[3px] transition-colors',
                active ? 'bg-white' : 'bg-white/35 hover:bg-white/60',
              )}
            />
          );
        })}
      </div>

      <div ref={railRef} className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
        {shots.map((shot) => {
          const active = shot.index === activeIndex;
          const thumbnail = localMediaUrl(shot.thumbnailPath);
          return (
            <button
              key={shot.id}
              type="button"
              data-shot-index={shot.index}
              aria-label={t('library.shotAlt', { index: shot.index + 1 })}
              aria-current={active}
              onClick={() => onSelect(shot)}
              className={cn(
                'group w-[104px] shrink-0 overflow-hidden rounded-lg text-left outline-none transition',
                active ? 'ring-2 ring-white' : 'ring-1 ring-white/15 hover:ring-white/40',
              )}
            >
              <div className="relative aspect-[9/16] w-full bg-black/40">
                {thumbnail ? (
                  <img src={thumbnail} alt="" loading="lazy" draggable={false} className="size-full object-cover" />
                ) : (
                  <span className="flex size-full items-center justify-center text-white/30">
                    <Film className="size-5" aria-hidden="true" />
                  </span>
                )}
                <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-white backdrop-blur-sm">
                  {String(shot.index + 1).padStart(2, '0')}
                </span>
              </div>
              <div className="flex items-center justify-between gap-1 bg-black/55 px-1.5 py-1 text-[10px] tabular-nums text-white/80">
                <span>{formatSeconds(shot.startMs)}</span>
                <span className="text-white/45">{formatSeconds(shot.endMs - shot.startMs)}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
