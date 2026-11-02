'use client';

/**
 * [INPUT]: the daemon's companion package metadata + the shared download hook.
 * [OUTPUT]: a download CTA (version + size, or "build it first"), browser install steps, and a
 *           first-capture walkthrough that hands off to the connection dialog.
 * [POS]: The library's "get the browser companion" entry point — the path from an empty library
 *        to material actually arriving here.
 *
 * Why a dialog instead of a bare download link: loading an unpacked extension is a four-step
 * browser ritual. A file that downloads with no instructions is the usual place this flow dies,
 * so the download and the explanation live in the same place.
 */
import { ArrowRight, Download, LoaderCircle, Puzzle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n, type DictKey } from '@/i18n';
import { useExtensionPackage } from './useExtensionPackage';

const INSTALL_STEPS: DictKey[] = [
  'library.ext.install1',
  'library.ext.install2',
  'library.ext.install3',
  'library.ext.install4',
];

const USAGE_STEPS: DictKey[] = [
  'library.ext.use1',
  'library.ext.use2',
  'library.ext.use3',
  'library.ext.use4',
];

/** Package size in the unit a download card usually shows; KB below 1 MB. */
function formatSize(bytes: number | null): string {
  if (bytes == null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function LibraryExtensionDialog({
  open,
  onClose,
  onConnect,
}: {
  open: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  const { t } = useI18n();
  const { info, loading, downloading, error, downloadedFile, download } = useExtensionPackage(open);
  const available = info?.available ?? false;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[86vh] w-[min(96vw,600px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Puzzle className="size-4" aria-hidden="true" />
            {t('library.ext.title')}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-5 text-muted-foreground">
            {t('library.ext.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]">
          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-secondary/30 p-4">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-background">
              <Download className="size-4 text-foreground" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">
                {available && info?.version
                  ? t('library.ext.meta', { version: info.version, size: formatSize(info.size) })
                  : t('library.ext.cta')}
              </p>
              <p className="mt-0.5 text-[11.5px] leading-5 text-muted-foreground">
                {loading
                  ? t('library.loading')
                  : info && !available
                    ? t('library.ext.missing')
                    : t('library.ext.hint')}
              </p>
              {downloadedFile && (
                <p role="status" className="mt-1 flex items-center gap-1.5 text-[11.5px] leading-5 text-foreground">
                  <Download className="size-3" aria-hidden="true" />
                  {t('library.ext.downloaded', { file: downloadedFile })}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              className="shrink-0 gap-1.5"
              disabled={downloading || loading || (info != null && !available)}
              onClick={() => void download()}
            >
              {downloading
                ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                : <Download className="size-3.5" aria-hidden="true" />}
              {downloading ? t('library.ext.downloading') : t('library.ext.download')}
            </Button>
          </div>

          {error && (
            <p role="alert" className="mt-3 rounded-md bg-secondary px-3 py-2 text-[12px]">{error}</p>
          )}

          <section className="mt-5">
            <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">{t('library.ext.installTitle')}</h3>
            <ol className="flex flex-col gap-2 text-[12.5px] leading-5 text-muted-foreground">
              {INSTALL_STEPS.map((key, index) => (
                <li key={key} className="flex gap-2">
                  <span className="shrink-0 font-medium text-foreground">{index + 1}.</span>
                  <span className="min-w-0 flex-1">{t(key)}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="mt-5">
            <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">{t('library.ext.useTitle')}</h3>
            <ol className="flex flex-col gap-2 text-[12.5px] leading-5 text-muted-foreground">
              {USAGE_STEPS.map((key, index) => (
                <li key={key} className="flex gap-2">
                  <span className="shrink-0 font-medium text-foreground">{index + 1}.</span>
                  <span className="min-w-0 flex-1">{t(key)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 px-5 py-3">
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t('library.ext.unsupported')}</span>
          <div className="flex shrink-0 items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.close')}</Button>
            <Button type="button" size="sm" className="gap-1.5" onClick={onConnect}>
              {t('library.ext.goConnect')}
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
