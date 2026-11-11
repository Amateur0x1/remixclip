'use client';

/**
 * [INPUT]: The library item the user chose, the shared download feed, and the guidance they type.
 * [OUTPUT]: A confirm dialog that collects an OPTIONAL brief ("只复刻前 5 秒"), unblocks a missing
 *           source by downloading it in place, then calls `onProceed(guidance)`.
 * [POS]: The one step between "让 AI 复刻这条" and a project. It exists because the handoff needs
 *        two things a card click cannot express: the guidance (optional, so the dialog must still be
 *        skippable) and a local source clip (without it the agent has no file to read at all).
 */
import { useEffect, useState } from 'react';
import type { LibraryItemSummary, MediaFileStatus } from '@remixclip/contracts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useDownloads } from './DownloadsCenter';
import { getLibraryShots } from '@/providers/library';
import { useI18n } from '@/i18n';

export function ReplicateDialog({
  item,
  onClose,
  onProceed,
}: {
  item: LibraryItemSummary | null;
  onClose: () => void;
  /** Guidance is already trimmed; an empty string means "recreate the whole clip as-is". */
  onProceed: (guidance: string) => void;
}) {
  const { entryFor, start } = useDownloads();
  const { t } = useI18n();
  const [guidance, setGuidance] = useState('');
  /** Media status straight from the item, for sources downloaded outside the feed's window. */
  const [probed, setProbed] = useState<MediaFileStatus | null>(null);
  const [probeSettled, setProbeSettled] = useState(false);
  const itemId = item?.id ?? null;

  // A fresh dialog is a fresh ask: carrying text from the previous item would silently steer it.
  useEffect(() => { setGuidance(''); }, [itemId]);

  // The download feed only covers active work plus roughly a day of results, so a clip downloaded
  // earlier has no entry there. Ask the item itself rather than reporting a downloaded source as
  // missing and re-downloading it.
  useEffect(() => {
    setProbed(null);
    setProbeSettled(false);
    if (!itemId) return;
    let cancelled = false;
    void getLibraryShots(itemId)
      .then((data) => { if (!cancelled) setProbed(data.media?.status ?? null); })
      .catch(() => { if (!cancelled) setProbed(null); })
      .finally(() => { if (!cancelled) setProbeSettled(true); });
    return () => { cancelled = true; };
  }, [itemId]);

  const entry = itemId ? entryFor(itemId) : undefined;
  const status = entry?.media.status ?? probed ?? undefined;
  const ready = status === 'ready';
  const running = status === 'pending' || status === 'downloading';
  const failed = status === 'failed';
  const percent = Math.round((entry?.media.progress ?? 0) * 100);
  // No feed entry and the probe is still in flight: showing "not downloaded" now would flash a
  // download prompt for a clip that is very likely already on disk.
  const checking = !entry && !probeSettled;

  const download = () => {
    if (!itemId) return;
    // A failure keeps the dialog open and surfaces under the source row; retrying is one click.
    void start(itemId).catch(() => {});
  };

  const proceed = () => {
    if (!ready) return;
    onProceed(guidance.trim());
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('library.replicateDialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('library.replicateDialogDesc', { title: item?.title || t('library.untitled') })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="replicate-guidance" className="text-xs font-medium text-foreground">
            {t('library.replicateGuidanceLabel')}
          </label>
          <Textarea
            id="replicate-guidance"
            rows={3}
            value={guidance}
            placeholder={t('library.replicateGuidancePlaceholder')}
            onChange={(event) => setGuidance(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                proceed();
              }
            }}
            className="min-h-[74px] resize-none text-[13px] leading-5"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('library.replicateGuidanceHint')}
          </p>
        </div>

        {!ready && !checking && (
          <div className="rounded-md border border-border/70 bg-secondary/40 px-3 py-2">
            <p className="text-[11.5px] leading-4 text-muted-foreground">
              {failed
                ? t('library.replicateSourceFailed')
                : t('library.replicateSourcePending')}
            </p>
            {running && (
              <div className="mt-2 flex items-center gap-2">
                <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-500"
                    style={{ width: `${status === 'pending' ? 4 : percent}%` }}
                  />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{percent}%</span>
              </div>
            )}
            {failed && entry?.media.error && (
              <p className="mt-1 truncate text-[11px] text-status-interrupted" title={entry.media.error}>
                {entry.media.error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {checking ? (
            <Button type="button" disabled>{t('library.replicateCheckingSource')}</Button>
          ) : ready ? (
            <Button type="button" onClick={proceed}>{t('library.replicateStart')}</Button>
          ) : (
            <Button type="button" disabled={running} onClick={download}>
              {running
                ? t('library.replicateDownloading', { percent })
                : t('library.replicateDownloadNow')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
