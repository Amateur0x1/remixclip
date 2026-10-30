'use client';

/**
 * [INPUT]: The extension-exported JSON file chosen by the user.
 * [OUTPUT]: Import confirmation dialog (platform inference, item stats, error hints).
 * [POS]: File import channel when unpaired; lands on the same normalization logic as live
 *   extension pushes.
 */
import { useEffect, useMemo, useState } from 'react';
import type { LibraryImportRequest, LibraryImportResult, SocialPlatform } from '@remixclip/contracts';
import { FileJson, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PLATFORM_META } from '@/providers/library';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function inferPlatform(filename: string): SocialPlatform {
  const name = filename.toLowerCase();
  if (name.includes('bilibili') || name.startsWith('bili')) return 'bilibili';
  if (name.includes('douyin') || name.startsWith('dy')) return 'douyin';
  return 'xhs';
}

export function LibraryImportDialog({
  file,
  onClose,
  onImport,
}: {
  file: File | null;
  onClose: () => void;
  onImport: (payload: LibraryImportRequest) => Promise<LibraryImportResult>;
}) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<LibraryImportRequest | null>(null);
  const [platform, setPlatform] = useState<SocialPlatform>('xhs');
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!file) {
      setPayload(null);
      setError('');
      return;
    }
    setPlatform(inferPlatform(file.name));
    setImporting(false);
    setError('');
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(t('library.import.notObject'));
        const record = parsed as LibraryImportRequest;
        const hasItems = ['notes', 'cards', 'users', 'items'].some((key) => Array.isArray((record as Record<string, unknown>)[key]));
        if (!hasItems) throw new Error(t('library.import.noFields'));
        if (record.platform) setPlatform(record.platform);
        setPayload({ ...record, filename: file.name });
      } catch (err) {
        setError(err instanceof Error ? err.message : t('library.import.parseFailed'));
      }
    });
  }, [file, t]);

  const stats = useMemo(() => {
    if (!payload) return { notes: 0, cards: 0, users: 0, comments: 0 };
    const notes = payload.notes?.length ?? 0;
    const cards = payload.cards?.length ?? 0;
    const users = payload.users?.length ?? 0;
    let comments = Object.values(payload.comments ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    for (const user of payload.users ?? []) {
      const record = user as { comments?: Record<string, unknown[]> };
      comments += Object.values(record.comments ?? {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
    }
    return { notes, cards, users, comments };
  }, [payload]);

  const submit = async () => {
    if (!payload) return;
    setImporting(true);
    setError('');
    try {
      await onImport({ ...payload, platform });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.import.failed'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={Boolean(file)} onOpenChange={(open) => { if (!open && !importing) onClose(); }}>
      <DialogContent className="w-[min(94vw,460px)] max-w-none gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <FileJson className="size-4" aria-hidden="true" />
            {t('library.importTitle')}
          </DialogTitle>
          <DialogDescription className="mt-1 truncate text-[12px] text-muted-foreground">
            {file?.name ?? ''}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4">
          {error ? (
            <p role="alert" className="rounded-md bg-secondary px-3 py-2 text-[12px] text-foreground">{error}</p>
          ) : !payload ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t('library.import.parsing')}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-4 gap-2">
                {[
                  { label: t('library.import.statNotes'), value: stats.notes },
                  { label: t('library.import.statCards'), value: stats.cards },
                  { label: t('library.import.statUsers'), value: stats.users },
                  { label: t('library.import.statComments'), value: stats.comments },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-lg bg-secondary/60 px-2 py-2 text-center">
                    <p className="text-[15px] font-semibold text-foreground">{value}</p>
                    <p className="text-[10.5px] text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>

              <p className="mt-4 mb-1.5 text-[11.5px] text-muted-foreground">{t('library.import.platformLabel')}</p>
              <div className="flex gap-1.5">
                {(Object.keys(PLATFORM_META) as SocialPlatform[]).map((key) => {
                  const meta = PLATFORM_META[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPlatform(key)}
                      className={cn(
                        'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-[12px] transition-colors',
                        platform === key
                          ? 'border-foreground/30 bg-secondary font-medium text-foreground'
                          : 'border-border text-muted-foreground hover:bg-secondary/60',
                      )}
                    >
                      <span className="size-1.5 rounded-full" style={{ backgroundColor: meta.color }} aria-hidden="true" />
                      {t(meta.labelKey)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground/80">
                {t('library.import.platformHint')}
              </p>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={importing}>{t('common.cancel')}</Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={!payload || importing}>
            {importing && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {importing ? t('library.import.importing') : t('library.import.action')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
