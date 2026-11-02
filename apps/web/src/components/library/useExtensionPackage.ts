/**
 * [INPUT]: whether a dialog that offers the browser companion is visible.
 * [OUTPUT]: build metadata, a download action, and the error/notice state both dialogs render.
 * [POS]: Shared state for "get the companion" surfaces (the download dialog and the connection
 *        dialog's inline download button), so the two never disagree about availability.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ExtensionPackageInfo } from '@remixclip/contracts';
import { downloadExtensionPackage, fetchExtensionInfo } from '@/providers/daemon';
import { t } from '@/i18n';

export function useExtensionPackage(active: boolean) {
  const [info, setInfo] = useState<ExtensionPackageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [downloadedFile, setDownloadedFile] = useState<string | null>(null);

  // Metadata is read once per opening: a rebuild while the dialog stays closed is picked up
  // the next time it opens, which is exactly when the user is about to click download.
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setDownloadedFile(null);
    void fetchExtensionInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('library.ext.downloadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);

  const download = useCallback(async () => {
    setDownloading(true);
    setError('');
    setDownloadedFile(null);
    try {
      setDownloadedFile(await downloadExtensionPackage());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('library.ext.downloadFailed'));
    } finally {
      setDownloading(false);
    }
  }, []);

  return { info, loading, downloading, error, downloadedFile, download };
}
