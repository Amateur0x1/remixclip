'use client';

/**
 * [INPUT]: The full report of one pixel check (per-shot scores + three comparison frame paths).
 * [OUTPUT]: Shot color bar, per-shot scores, and a three-column source / render / diff comparison.
 * [POS]: The final readout for render quality; all images go through the local media proxy.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Comparison, ComparisonShot, ComparisonStatus } from '@remixclip/contracts';
import { ImageOff, LoaderCircle } from 'lucide-react';
import { localMediaUrl } from '@/providers/library';
import { useI18n, type DictKey } from '@/i18n';
import { cn } from '@/lib/utils';
import { formatSeconds } from './LibraryItemCard';

type ShotStatus = ComparisonShot['status'];

const SHOT_STATUS_META: Record<ShotStatus, { labelKey: DictKey; bg: string; dot: string }> = {
  match: { labelKey: 'library.shotMatch', bg: 'bg-emerald-500', dot: 'bg-emerald-400' },
  minor: { labelKey: 'library.shotMinor', bg: 'bg-amber-500', dot: 'bg-amber-400' },
  mismatch: { labelKey: 'library.shotMismatch', bg: 'bg-rose-500', dot: 'bg-rose-400' },
};

export const COMPARISON_STATUS_META: Record<ComparisonStatus, { labelKey: DictKey; text: string; dot: string }> = {
  running: { labelKey: 'library.compareRunning', text: 'text-sky-400', dot: 'bg-sky-400' },
  match: { labelKey: 'library.compareMatch', text: 'text-emerald-400', dot: 'bg-emerald-400' },
  minor: { labelKey: 'library.compareMinor', text: 'text-amber-400', dot: 'bg-amber-400' },
  mismatch: { labelKey: 'library.compareMismatch', text: 'text-rose-400', dot: 'bg-rose-400' },
  'structure-mismatch': { labelKey: 'library.compareStructure', text: 'text-orange-400', dot: 'bg-orange-400' },
  failed: { labelKey: 'library.compareFailed', text: 'text-rose-400', dot: 'bg-rose-400' },
};

export function shotStatusMeta(status: ShotStatus) {
  return SHOT_STATUS_META[status];
}

/** Score color: green at 0.98+, amber at 0.9+, red otherwise, matching the daemon thresholds. */
export function scoreTone(score: number): string {
  if (score >= 0.98) return 'text-emerald-400';
  if (score >= 0.9) return 'text-amber-400';
  return 'text-rose-400';
}

function FramePane({ src, label, caption }: { src?: string; label: string; caption?: string }) {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  const url = localMediaUrl(src);

  return (
    <figure className="flex min-h-0 min-w-0 flex-col">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md bg-black/60">
        {url && !broken ? (
          <img
            src={url}
            alt={label}
            draggable={false}
            className="max-h-full max-w-full object-contain"
            onError={() => setBroken(true)}
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-white/25">
            <ImageOff className="size-4" aria-hidden="true" />
            <span className="text-[10px]">{t('library.noFrame')}</span>
          </span>
        )}
      </div>
      <figcaption className="mt-1 flex items-center justify-between gap-1 text-[10.5px] text-white/55">
        <span className="truncate">{label}</span>
        {caption && <span className="shrink-0 tabular-nums text-white/40">{caption}</span>}
      </figcaption>
    </figure>
  );
}

export function ComparisonBoard({
  comparison,
  activeShotIndex,
  onSelectShot,
}: {
  comparison: Comparison;
  activeShotIndex: number | null;
  onSelectShot: (index: number) => void;
}) {
  const { t } = useI18n();
  const [frameIndex, setFrameIndex] = useState(1);

  const shots = comparison.report.shots;
  const shot = useMemo(() => {
    if (shots.length === 0) return null;
    if (activeShotIndex != null) {
      const hit = shots.find((entry) => entry.index === activeShotIndex);
      if (hit) return hit;
    }
    return shots[0];
  }, [shots, activeShotIndex]);

  useEffect(() => { setFrameIndex(1); }, [shot?.index]);

  if (comparison.status === 'running' && shots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-white/55">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        <p className="text-[12px]">{t('library.comparingFrames')}</p>
      </div>
    );
  }

  if (shots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center text-white/45">
        <p className="text-[12.5px]">{comparison.report.error || t('library.noFrames')}</p>
        <p className="text-[11px] text-white/30">{t('library.compareRetryHint')}</p>
      </div>
    );
  }

  const frame = shot?.frames[Math.min(frameIndex, Math.max(0, (shot?.frames.length ?? 1) - 1))];
  const total = shots.reduce((sum, entry) => sum + Math.max(1, entry.endMs - entry.startMs), 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Shot color bar: see at a glance which segment loses points */}
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-white/10">
        {shots.map((entry) => (
          <button
            key={entry.index}
            type="button"
            aria-label={t('library.shotScoreAria', { index: entry.index + 1, score: Math.round(entry.score * 100) })}
            onClick={() => onSelectShot(entry.index)}
            style={{ width: `${(Math.max(1, entry.endMs - entry.startMs) / Math.max(1, total)) * 100}%` }}
            className={cn(
              'h-full min-w-[3px] transition-opacity',
              shotStatusMeta(entry.status).bg,
              shot && entry.index === shot.index ? 'opacity-100' : 'opacity-45 hover:opacity-80',
            )}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-white/55">
        <span className="inline-flex items-center gap-1">
          {t('library.shotWord')} <span className="tabular-nums text-white/85">{shot!.index + 1}</span> / {shots.length}
        </span>
        <span className="tabular-nums">{formatSeconds(shot!.startMs)} – {formatSeconds(shot!.endMs)}</span>
        <span className={cn('inline-flex items-center gap-1', scoreTone(shot!.score))}>
          <span className={cn('size-1.5 rounded-full', shotStatusMeta(shot!.status).dot)} aria-hidden="true" />
          {t(shotStatusMeta(shot!.status).labelKey)} · {(shot!.score * 100).toFixed(1)}%
        </span>
        <span className="ml-auto flex items-center gap-1">
          {shot!.frames.map((entry, index) => (
            <button
              key={`${entry.atMs}-${index}`}
              type="button"
              aria-label={t('library.sampleFrameAria', { index: index + 1 })}
              aria-current={index === frameIndex}
              onClick={() => setFrameIndex(index)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10.5px] tabular-nums transition-colors',
                index === frameIndex ? 'bg-white text-black' : 'bg-white/10 text-white/60 hover:bg-white/20',
              )}
            >
              {formatSeconds(entry.atMs)}
            </button>
          ))}
        </span>
      </div>

      {/* Three-column comparison */}
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
        <FramePane src={frame?.sourcePath} label={t('library.rowSource')} caption={formatSeconds(frame?.atMs)} />
        <FramePane src={frame?.renderPath} label={t('library.frameRender')} caption={frame ? `${(frame.score * 100).toFixed(0)}%` : undefined} />
        <FramePane src={frame?.diffPath} label={t('library.frameDiff')} caption={frame ? t('library.perceptualCaption', { percent: (frame.perceptualRatio * 100).toFixed(1) }) : undefined} />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-[10.5px] text-white/40">
        <span>{t('library.exactDiff', { percent: (frame ? frame.exactRatio * 100 : 0).toFixed(2) })}</span>
        <span>{t('library.perceptualDiff', { percent: (frame ? frame.perceptualRatio * 100 : 0).toFixed(2) })}</span>
        {comparison.report.width && comparison.report.height && (
          <span>{t('library.aligned', { width: comparison.report.width, height: comparison.report.height })}</span>
        )}
        <span>{t('library.shotCountSummary', { sourceCount: comparison.report.sourceShotCount, renderCount: comparison.report.renderShotCount })}</span>
      </div>
      {comparison.report.error && (
        <p className="shrink-0 text-[11px] text-rose-300/90">{comparison.report.error}</p>
      )}
    </div>
  );
}
