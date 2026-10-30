'use client';

/**
 * [INPUT]: Library item id; the daemon's local source / shots / comparison record endpoints.
 * [OUTPUT]: Source download progress, shot timeline, render list, pixel check results, and all
 *   trigger actions.
 * [POS]: Orchestration layer for the "download → shot analysis → render → check" chain in the item
 *   detail view; components only render.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Comparison, MediaFile, Shot, ShotJob } from '@remixclip/contracts';
import {
  analyzeLibraryShots,
  downloadLibraryVideo,
  getLibraryShots,
  listLibraryComparisons,
  listLibraryMedia,
  startLibraryComparison,
  uploadLibraryRender,
} from '@/providers/library';
import { t } from '@/i18n';

export type PipelineBusy = 'download' | 'analyze' | 'render' | 'compare' | null;

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Poll interval: local daemon, download progress must feel responsive, other jobs stay light. */
const POLL_MS = 1200;

export function useMediaPipeline(itemId: string | null) {
  const [media, setMedia] = useState<MediaFile[]>([]);
  const [shots, setShots] = useState<Shot[]>([]);
  const [shotJob, setShotJob] = useState<ShotJob | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [activeComparisonId, setActiveComparisonId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<PipelineBusy>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // ── Reads ───────────────────────────────────────────────────────────────
  const refreshMedia = useCallback(async (silent = true) => {
    if (!itemId) return;
    try {
      const list = await listLibraryMedia(itemId);
      setMedia(list);
    } catch (err) {
      if (!silent) setError(messageOf(err, t('errors.mediaListRead')));
    }
  }, [itemId]);

  const refreshShots = useCallback(async (silent = true) => {
    if (!itemId) return;
    try {
      const data = await getLibraryShots(itemId);
      setShots(data.shots);
      setShotJob(data.job);
      if (data.media) {
        const next = data.media;
        // The shots endpoint also returns the baseline source: merge it into the list so we
        // don't show "not downloaded" before the other request has come back.
        setMedia((prev) => [next, ...prev.filter((entry) => entry.id !== next.id)]);
      }
    } catch (err) {
      if (!silent) setError(messageOf(err, t('errors.shotsRead')));
    }
  }, [itemId]);

  const refreshComparisons = useCallback(async (silent = true) => {
    if (!itemId) return;
    try {
      const data = await listLibraryComparisons(itemId);
      setComparisons(data.comparisons);
    } catch (err) {
      if (!silent) setError(messageOf(err, t('errors.comparisonsRead')));
    }
  }, [itemId]);

  // Switching items: clear the previous state and fetch all three chains in parallel.
  useEffect(() => {
    setMedia([]);
    setShots([]);
    setShotJob(null);
    setComparisons([]);
    setActiveComparisonId(null);
    setError('');
    setNotice('');
    setBusy(null);
    if (!itemId) return;

    let cancelled = false;
    setLoading(true);
    void Promise.allSettled([
      listLibraryMedia(itemId).then((list) => { if (!cancelled) setMedia(list); }),
      getLibraryShots(itemId).then((data) => {
        if (cancelled) return;
        setShots(data.shots);
        setShotJob(data.job);
        if (data.media) setMedia((prev) => [data.media!, ...prev.filter((entry) => entry.id !== data.media!.id)]);
      }),
      listLibraryComparisons(itemId).then((data) => { if (!cancelled) setComparisons(data.comparisons); }),
    ]).finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [itemId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ── Derived state ───────────────────────────────────────────────────────
  const source = useMemo(() => {
    const sources = media.filter((entry) => entry.kind === 'source');
    return sources.find((entry) => entry.status === 'ready') ?? sources[0] ?? null;
  }, [media]);

  const renders = useMemo(() => media.filter((entry) => entry.kind === 'render'), [media]);

  const activeComparison = useMemo(() => {
    if (activeComparisonId) {
      const hit = comparisons.find((entry) => entry.id === activeComparisonId);
      if (hit) return hit;
    }
    return comparisons[0] ?? null;
  }, [comparisons, activeComparisonId]);

  const downloading = source?.status === 'pending' || source?.status === 'downloading';
  const analyzing = shotJob?.status === 'running';
  const comparing = comparisons.some((entry) => entry.status === 'running');

  // ── Polling: only runs while download/analysis/comparison is actually in progress ──
  useEffect(() => {
    if (!itemId || (!downloading && !analyzing && !comparing)) return;
    const timer = setInterval(() => {
      if (downloading) void refreshMedia(false);
      if (analyzing) void refreshShots(false);
      if (comparing) void refreshComparisons(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [itemId, downloading, analyzing, comparing, refreshMedia, refreshShots, refreshComparisons]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const download = useCallback(async () => {
    if (!itemId) return;
    setBusy('download');
    setError('');
    try {
      const created = await downloadLibraryVideo(itemId);
      setMedia((prev) => [created, ...prev.filter((entry) => entry.id !== created.id)]);
      setNotice(created.status === 'ready' ? t('library.sourceReady') : t('library.downloadQueued'));
    } catch (err) {
      setError(messageOf(err, t('errors.mediaDownload')));
    } finally {
      setBusy(null);
    }
  }, [itemId]);

  const analyze = useCallback(async () => {
    if (!itemId) return;
    setBusy('analyze');
    setError('');
    try {
      const job = await analyzeLibraryShots(itemId);
      setShotJob(job);
      await refreshShots(false);
    } catch (err) {
      setError(messageOf(err, t('errors.analyze')));
    } finally {
      setBusy(null);
    }
  }, [itemId, refreshShots]);

  const uploadRender = useCallback(async (file: File) => {
    if (!itemId) return null;
    setBusy('render');
    setError('');
    try {
      const uploaded = await uploadLibraryRender(itemId, file, file.name);
      setMedia((prev) => [uploaded, ...prev.filter((entry) => entry.id !== uploaded.id)]);
      setNotice(t('library.renderReady'));
      return uploaded;
    } catch (err) {
      setError(messageOf(err, t('errors.renderUpload')));
      return null;
    } finally {
      setBusy(null);
    }
  }, [itemId]);

  const compare = useCallback(async (renderMediaId: string) => {
    if (!itemId) return;
    setBusy('compare');
    setError('');
    try {
      const started = await startLibraryComparison(itemId, { renderMediaId });
      setActiveComparisonId(started.comparisonId);
      await refreshComparisons(false);
    } catch (err) {
      setError(messageOf(err, t('errors.compareStart')));
    } finally {
      setBusy(null);
    }
  }, [itemId, refreshComparisons]);

  return {
    loading, busy, error, notice, setNotice,
    media, source, renders,
    shots, shotJob, analyzing,
    comparisons, activeComparison, activeComparisonId, setActiveComparisonId, comparing,
    downloading,
    download, analyze, uploadRender, compare,
  };
}
