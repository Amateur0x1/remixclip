/**
 * [INPUT]: language tags from the browser/desktop shell (BCP-47, possibly mixed case).
 * [OUTPUT]: a normalized `Locale`; null when no usable information is available (the caller
 *           decides the fallback).
 * [POS]: pure function, no DOM dependency, so the i18n runtime and the check script can call it
 *        directly.
 */
import { DEFAULT_LOCALE, type Locale } from './types';

/** Traditional-Chinese markers: script subtags such as `zh-Hant` or `Hant`. */
const HANT_SCRIPT = /(?:^|-)hant(?:-|$)/i;
/** Traditional-Chinese regions: we only ship the simplified bundle, so map these to zh-CN for now. */
const HANT_REGIONS = new Set(['tw', 'hk', 'mo']);

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * The caller decides the resolution order (localStorage(manual) > desktop injection >
 * navigator.languages > default); this function only folds a list of language tags into one
 * supported locale:
 *
 * - case-insensitive (`ZH-cn` is equivalent to `zh-CN`);
 * - Traditional Chinese behind `zh` (Hant / tw / hk / mo) explicitly maps to zh-CN — we only
 *   ship the simplified bundle for now. **When adding zh-TW later, change only this branch**;
 * - everything else non-Chinese falls back to en;
 * - when everything is empty/invalid, return null and let the caller decide the default.
 */
export function resolveSystemLocale(languages: readonly string[]): Locale | null {
  for (const raw of languages) {
    if (typeof raw !== 'string') continue;
    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (!tag.startsWith('zh')) return 'en';

    const region = tag.split('-')[1] ?? '';
    if (HANT_SCRIPT.test(tag) || HANT_REGIONS.has(region)) {
      // Traditional-Chinese users currently land on the simplified bundle: an explicit branch
      // instead of relying on startsWith('zh'), so adding zh-TW only requires changing this.
      return DEFAULT_LOCALE;
    }
    return 'zh-CN';
  }
  return null;
}
