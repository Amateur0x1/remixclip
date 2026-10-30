'use client';

/**
 * [INPUT]: Auto-pair window state and the connected devices list.
 * [OUTPUT]: One-click pairing wizard (opens a 2-minute trust window for the extension) plus the
 *   device list with live refresh/revoke.
 * [POS]: The binding entry point between the library and RemixClip Companion (the browser extension).
 *
 * Why a window instead of a code? A code is unguessable but costs a copy/paste round trip, and on
 * a single-user local daemon it proves nothing more than "the person at this screen clicked a
 * button". The trust window proves exactly that, expires on its own, and is bound to the
 * chrome-extension origin, so there is nothing to copy, leak or expire in a user's clipboard.
 */
import { useCallback, useEffect, useState } from 'react';
import type { LibraryPairingInfo } from '@remixclip/contracts';
import { Check, LoaderCircle, Plug, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fetchPairing, openPairWindow, revokeDevice } from '@/providers/library';
import { getLocale, useI18n } from '@/i18n';

export function LibraryConnectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [info, setInfo] = useState<LibraryPairingInfo | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [autoUntil, setAutoUntil] = useState(0);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async (silent = false) => {
    try {
      setInfo(await fetchPairing());
      setError('');
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : t('library.connect.fetchFailed'));
    }
  }, [t]);

  useEffect(() => {
    if (!open) return;
    setAutoUntil(0);
    void load();
  }, [open, load]);

  // Ticking clock: powers the countdown while the trust window is open.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  // Poll devices while the dialog is visible, so the extension's pair lands here without a refresh.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [open, load]);

  const startAuto = async () => {
    setStarting(true);
    setError('');
    try {
      setAutoUntil(await openPairWindow());
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.connect.fetchFailed'));
    } finally {
      setStarting(false);
    }
  };

  const autoActive = autoUntil > now;
  const secondsLeft = Math.max(0, Math.ceil((autoUntil - now) / 1000));
  const autoClock = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;
  const deviceCount = info?.devices.length ?? 0;

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
            <li><span className="mr-1.5 font-medium text-foreground">1.</span>{t('library.connect.step1Prefix')}<code className="rounded bg-secondary px-1">chrome://extensions</code>{t('library.connect.step1Middle')}<code className="rounded bg-secondary px-1">extensions/remixclip-companion/dist</code>{t('library.connect.step1Suffix')}</li>
            <li><span className="mr-1.5 font-medium text-foreground">2.</span>{t('library.connect.step2')}</li>
            <li><span className="mr-1.5 font-medium text-foreground">3.</span>{t('library.connect.step3')}</li>
          </ol>

          <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-secondary/30 p-4">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-background">
              <Zap className="size-4 text-foreground" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-foreground">{t('library.connect.autoTitle')}</p>
              <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">
                {autoActive ? t('library.connect.autoOpen', { time: autoClock }) : t('library.connect.autoDesc')}
              </p>
              {autoActive && (
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground/80">{t('library.connect.autoOpenHint')}</p>
              )}
              {!autoActive && autoUntil > 0 && (
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground/80">{t('library.connect.autoExpiredHint')}</p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={starting}
              onClick={() => void startAuto()}
            >
              {starting && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
              {autoActive ? t('library.connect.autoReopen') : t('library.connect.autoAction')}
            </Button>
          </div>

          {deviceCount > 0 && (
            <p role="status" className="mt-2 flex items-center gap-1.5 text-[12px] text-foreground">
              <Check className="size-3.5" aria-hidden="true" />
              {t('library.connect.autoDone', { count: deviceCount })}
            </p>
          )}

          <section className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[12px] font-medium text-muted-foreground">{t('library.connect.devices')}</h3>
              <span className="text-[11px] text-muted-foreground/70">{t('library.connect.deviceCount', { count: deviceCount })}</span>
            </div>
            {info && info.devices.length > 0 ? (
              <ul className="flex flex-col gap-1">
                {info.devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-2 rounded-lg bg-secondary/50 px-3 py-2 text-[12px]">
                    <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{device.name}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {new Date(device.createdAt).toLocaleDateString(getLocale())}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t('library.connect.revoke', { name: device.name })}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        void revokeDevice(device.id).then(() => load()).catch((err) => {
                          setError(err instanceof Error ? err.message : t('library.connect.revokeFailed'));
                        });
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground">
                {t('library.connect.noDevices')}
              </p>
            )}
          </section>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border/70 px-5 py-3">
          <span className="text-[11px] text-muted-foreground">{t('library.connect.loopback')}</span>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t('library.connect.finish')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
