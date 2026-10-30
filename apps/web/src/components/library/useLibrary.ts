'use client';

/**
 * [INPUT]: Library query filters, import requests, and the item pages returned by the daemon.
 * [OUTPUT]: List state (including cache backfill and silent refresh when switching platforms),
 *   pagination, and import/delete actions.
 * [POS]: Data orchestration for the library tab; components only render.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryImportRequest, LibraryImportResult, LibraryItemSummary, SocialPlatform } from '@remixclip/contracts';
import { clearLibrary, deleteLibraryItem, importLibraryPayload, listLibrary } from '@/providers/library';
import { t } from '@/i18n';

export type LibrarySort = 'imported' | 'published' | 'likes';

type Counts = Record<SocialPlatform, number> & { all: number };

interface PageSnapshot {
  items: LibraryItemSummary[];
  total: number;
  counts: Counts;
}

const EMPTY_COUNTS: Counts = { all: 0, xhs: 0, bilibili: 0, douyin: 0 };
const PAGE_SIZE = 60;
/** Cache cap: query filter combinations can be many; beyond this, evict in insertion order. */
const MAX_SNAPSHOTS = 24;

/**
 * Module-level cache: even if the library panel is switched away and rebuilt, it can backfill the
 * previous frame, avoiding another skeleton screen. Every write (import/delete/clear) wipes it.
 */
const snapshots = new Map<string, PageSnapshot>();
let hasRendered = false;

function snapshotKey(platform: 'all' | SocialPlatform, query: string, sort: LibrarySort): string {
  return `${platform}\u0000${query}\u0000${sort}`;
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useLibrary() {
  const [platform, setPlatform] = useState<'all' | SocialPlatform>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<LibrarySort>('imported');
  // Render the first frame from the default-filter cache, so a remounting panel doesn't
  // flash empty before filling in.
  const [items, setItems] = useState<LibraryItemSummary[]>(() => snapshots.get(snapshotKey('all', '', 'imported'))?.items ?? []);
  const [total, setTotal] = useState(() => snapshots.get(snapshotKey('all', '', 'imported'))?.total ?? 0);
  const [counts, setCounts] = useState<Counts>(() => snapshots.get(snapshotKey('all', '', 'imported'))?.counts ?? EMPTY_COUNTS);
  /** True only when there is nothing displayable at all — the skeleton must not flash per request. */
  const [loading, setLoading] = useState(() => snapshots.size === 0);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const debouncedQuery = useDebouncedValue(query, 260);
  const requestId = useRef(0);

  const fetchPage = useCallback(async (offset: number, append: boolean, silent = false) => {
    const key = snapshotKey(platform, debouncedQuery, sort);
    const snapshot = snapshots.get(key);
    const id = ++requestId.current;

    if (append) {
      setLoadingMore(true);
    } else if (snapshot) {
      // Cache hit: show old content first, then refresh in the background, so the grid
      // isn't unmounted and rebuilt wholesale.
      setItems(snapshot.items);
      setTotal(snapshot.total);
      setCounts(snapshot.counts);
      setLoading(false);
      if (!silent) setRefreshing(true);
    } else if (hasRendered) {
      // First switch to a platform: keep the current grid, replace it wholesale once new data
      // arrives.
      if (!silent) setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const data = await listLibrary({
        platform,
        q: debouncedQuery,
        sort,
        limit: PAGE_SIZE,
        offset,
      });
      if (id !== requestId.current) return;

      const merged = append ? [...(snapshot?.items ?? []), ...data.items] : data.items;
      if (snapshots.size >= MAX_SNAPSHOTS && !snapshots.has(key)) {
        const oldest = snapshots.keys().next().value;
        if (oldest !== undefined) snapshots.delete(oldest);
      }
      snapshots.set(key, { items: merged, total: data.total, counts: data.counts });

      hasRendered = true;
      setItems(merged);
      setTotal(data.total);
      setCounts(data.counts);
      setError('');
    } catch (err) {
      if (id !== requestId.current) return;
      setError(err instanceof Error ? err.message : t('errors.libraryRead'));
    } finally {
      if (id === requestId.current) {
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    }
  }, [debouncedQuery, platform, sort]);

  useEffect(() => { void fetchPage(0, false); }, [fetchPage]);

  // No manual refresh needed after extension pushes: poll at low frequency while visible, stop when
  // the window loses focus. Polls run silently and trigger no visual state.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        void fetchPage(0, false, true);
      }
    }, 8000);
    return () => clearInterval(timer);
  }, [fetchPage]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const refresh = useCallback(async () => {
    await fetchPage(0, false, true);
  }, [fetchPage]);

  const importPayload = useCallback(async (payload: LibraryImportRequest): Promise<LibraryImportResult> => {
    const result = await importLibraryPayload(payload);
    const parts = [t('library.importedNotice', { count: result.batch.itemCount })];
    if (result.created) parts.push(t('library.addedNotice', { count: result.created }));
    if (result.updated) parts.push(t('library.updatedNotice', { count: result.updated }));
    setNotice(parts.join(' · '));
    snapshots.clear();
    await fetchPage(0, false, true);
    return result;
  }, [fetchPage]);

  const removeItem = useCallback(async (id: string) => {
    await deleteLibraryItem(id);
    setItems((current) => current.filter((item) => item.id !== id));
    setTotal((current) => Math.max(0, current - 1));
    setNotice(t('library.removedNotice'));
    snapshots.clear();
    await fetchPage(0, false, true);
  }, [fetchPage]);

  const clearAll = useCallback(async () => {
    const removed = await clearLibrary();
    setNotice(t('library.clearedNotice', { count: removed }));
    snapshots.clear();
    await fetchPage(0, false, true);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore || items.length >= total) return;
    await fetchPage(items.length, true, true);
  }, [fetchPage, items.length, loadingMore, total]);

  return useMemo(() => ({
    platform, setPlatform,
    query, setQuery,
    sort, setSort,
    items, total, counts,
    loading, refreshing, loadingMore, error, notice, setNotice,
    hasMore: items.length < total,
    refresh, importPayload, removeItem, clearAll, loadMore,
  }), [
    platform, query, sort, items, total, counts, loading, refreshing, loadingMore,
    error, notice, refresh, importPayload, removeItem, clearAll, loadMore,
  ]);
}
