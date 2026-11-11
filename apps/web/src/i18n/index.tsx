'use client';

/**
 * [INPUT]: locale dictionaries (locales/*), language detection (resolve-locale) and the
 *          localStorage preference.
 * [OUTPUT]: `I18nProvider` / `useI18n()` (locale, setLocale, t), plus a `t()` usable outside
 *           components.
 * [POS]: hand-rolled i18n runtime; next-intl is avoided (it pulls in routing/middleware and
 *        conflicts with static export).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { DICTS } from './locales';
import { resolveSystemLocale } from './resolve-locale';
import {
  DEFAULT_LOCALE,
  isLocale,
  LOCALE_SOURCE_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  type DictKey,
  type Locale,
  type LocaleSource,
} from './types';

export { LOCALES, LOCALE_LABEL, DEFAULT_LOCALE } from './types';
export type { Dict, DictKey, Locale } from './types';
export { resolveSystemLocale } from './resolve-locale';

export type TranslateVars = Record<string, string | number>;

// ── module-level state ────────────────────────────────────────────────────
// Outside components, t() (hooks / providers / formatters) reads the same currentLocale;
// inside components, useI18n() subscribes so the tree re-renders when the locale changes.

let currentLocale: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // localStorage may throw outright in private mode
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Same as above: if the write fails, it only applies to this session
  }
}

/**
 * The system locale injected by the desktop shell.
 *
 * Convention: preload / main write `app.getLocale()` into `window.__remixclipLocale`.
 * Current state: apps/desktop/src/main does not inject it yet, so both dev and packaged builds
 * fall back to navigator.languages.
 */
function readInjectedLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as Window & { __remixclipLocale?: unknown }).__remixclipLocale;
  return typeof injected === 'string' ? resolveSystemLocale([injected]) : null;
}

/** Whether the saved preference came from an explicit user choice (only manual counts). */
function readManualLocale(): Locale | null {
  if (typeof window === 'undefined') return null;
  if (readStorage(LOCALE_SOURCE_STORAGE_KEY) !== 'manual') return null;
  const stored = readStorage(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : null;
}

/**
 * Resolve the initial locale: localStorage(manual) > desktop injection > navigator.languages >
 * default zh-CN.
 *
 * Auto-detected values are persisted too (source='auto'), but they do not take part in the next
 * launch's priority — otherwise an early detected value would pin the UI and a later
 * system-language change would never be followed.
 */
export function resolveInitialLocale(): { locale: Locale; source: LocaleSource } {
  if (typeof window === 'undefined') return { locale: DEFAULT_LOCALE, source: 'auto' };
  const manual = readManualLocale();
  if (manual) return { locale: manual, source: 'manual' };
  const detected = readInjectedLocale()
    ?? resolveSystemLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
  return { locale: detected ?? DEFAULT_LOCALE, source: 'auto' };
}

/** The current locale (snapshot read outside components). */
export function getLocale(): Locale {
  return currentLocale;
}

/** Switch locale and persist it. `source` should stay at the default 'manual' except during provider init. */
export function setLocale(next: Locale, source: LocaleSource = 'manual'): void {
  currentLocale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (typeof window !== 'undefined') {
    writeStorage(LOCALE_STORAGE_KEY, next);
    writeStorage(LOCALE_SOURCE_STORAGE_KEY, source);
  }
  emit();
}

/**
 * Look up one string. Fallback chain: locale → zh-CN → the key itself.
 * A missing variable keeps `{name}` verbatim instead of silently becoming undefined.
 */
export function translate(locale: Locale, key: DictKey, vars?: TranslateVars): string {
  const template: string = DICTS[locale][key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
}

/**
 * Read a string outside components (hooks / providers / formatters).
 * Inside components prefer `useI18n().t` so the tree re-renders on locale changes.
 */
export function t(key: DictKey, vars?: TranslateVars): string {
  return translate(currentLocale, key, vars);
}

// ── React bindings ────────────────────────────────────────────────────────

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: DictKey, vars?: TranslateVars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  // The statically exported HTML is always prerendered in the default locale (zh-CN); the first
  // client frame matches it, and the detected locale is applied in an effect to avoid
  // hydration mismatches.
  const locale = useSyncExternalStore(subscribe, getLocale, () => DEFAULT_LOCALE);

  useEffect(() => {
    const initial = resolveInitialLocale();
    setLocale(initial.locale, initial.source);
  }, []);

  // Keep <html lang> in sync with the locale (the static zh-CN from layout stays; only the
  // runtime value changes) as well as document.title: metadata is decided by the server
  // component and, with static export, can only be the default locale — so fill in the current
  // one on the client.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, 'app.metadata.title');
  }, [locale]);

  const changeLocale = useCallback((next: Locale) => setLocale(next, 'manual'), []);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale: changeLocale,
    t: (key, vars) => translate(locale, key, vars),
  }), [locale, changeLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>');
  return context;
}
