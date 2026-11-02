'use client';

/**
 * [INPUT]: the daemon's bound port plus the companion heartbeats it received recently, and the
 *          shared extension download hook.
 * [OUTPUT]: install steps, the port the extension should dial, and live "connected" feedback.
 * [POS]: The library's "connect the browser companion" dialog.
 *
 * There is no pairing step and no code: the extension probes this daemon every time its side panel
 * opens, remembers the port that answered, and sends a heartbeat. This dialog only has to make that
 * port visible for the case where the app is not on the default 7456.
 */
import { useCallback, useEffect, useState } from 'react';
import type { LibraryConnectionInfo } from '@remixclip/contracts';
import { Check, Copy, Download, LoaderCircle, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchConnection } from '@/providers/library';
import { getLocale, useI18n } from '@/i18n';
import { useExtensionPackage } from './useExtensionPackage';

/** Must match the extension's first probe (see extensions/remixclip-companion/src/lib/remixclip.ts). */
const DEFAULT_PORT = 7456;

export function LibraryConnectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<LibraryConnectionInfo | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const ext = useExtensionPackage(open);

  const load = useCallback(async (silent = false) => {
    try {
      setInfo(await fetchConnection());
      setError('');
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : t('library.connect.fetchFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    void load();
  }, [open, load]);

  // Poll while visible: a heartbeat lands here within a few seconds of the extension connecting.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [open, load]);

  const copyEndpoint = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t('library.copyFailed'));
    }
  };

  const companions = info?.companions ?? [];
  const latest = companions[0];
  const port = info?.port;
  /** What the user types into the extension: host:port, or the full endpoint when the port is unknown. */
  const address = port != null ? `127.0.0.1:${port}` : info?.endpoint;
  const isDefaultPort = port == null || port === DEFAULT_PORT;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="flex max-h-[86vh] w-[min(96vw,560px)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border/70 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Plug className="size-4" aria-hidden="true" />
            {t('library.connect.title')}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[12px] text-muted-foreground">
            {t('library.connect.desc')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]">
          {error && <p role="alert" className="mb-3 rounded-md bg-secondary px-3 py-2 text-[12px]">{error}</p>}

          <ol className="mb-4 flex flex-col gap-2 text-[12.5px] leading-5 text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="shrink-0 font-medium text-foreground">1.</span>
              <span className="min-w-0 flex-1">{t('library.connect.step1')}</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0 gap-1"
                disabled={ext.downloading || ext.loading}
                onClick={() => void ext.download()}
              >
                {ext.downloading
                  ? <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                  : <Download className="size-3" aria-hidden="true" />}
                {t('library.connect.download')}
              </Button>
            </li>
            <li><span className="mr-1.5 font-medium text-foreground">2.</span>{t('library.connect.step2')}</li>
            <li><span className="mr-1.5 font-medium text-foreground">3.</span>{t('library.connect.step3')}</li>
          </ol>

          {address && (
            <div className="mb-3 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{t('library.connect.port')}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">{address}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 gap-1"
                  onClick={() => void copyEndpoint()}
                >
                  <Copy className="size-3" aria-hidden="true" />
                  {copied ? t('library.connect.copiedEndpoint') : t('library.connect.copyEndpoint')}
                </Button>
              </div>
              {!isDefaultPort && (
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground/80">
                  {t('library.connect.portHint', { port: String(port) })}
                </p>
              )}
            </div>
          )}

          {(ext.error || ext.downloadedFile) && (
            <p
              role={ext.error ? 'alert' : 'status'}
              className="mb-3 flex items-center gap-1.5 rounded-md bg-secondary px-3 py-2 text-[12px]"
            >
              {ext.error ?? t('library.ext.downloaded', { file: ext.downloadedFile ?? '' })}
            </p>
          )}

          <section>
            <h3 className="mb-2 text-[12px] font-medium text-muted-foreground">{t('library.connect.companions')}</h3>
            {latest ? (
              <p role="status" className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-[12px]">
                <Check className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {t('library.connect.seen', {
                    name: latest.name,
                    time: new Date(latest.lastSeenAt).toLocaleTimeString(getLocale()),
                  })}
                </span>
              </p>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] leading-5 text-muted-foreground">
                {t('library.connect.none')}
              </p>
            )}
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/70 px-5 py-3">
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">{t('library.connect.loopback')}</span>
          <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={onClose}>
            {t('library.connect.finish')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
