/**
 * [INPUT]: the per-locale dictionary modules.
 * [OUTPUT]: a locale → dictionary map.
 * [POS]: the dictionary entry point shared by the i18n runtime and `scripts/i18n-check.ts`.
 */
import type { Dict, Locale } from '../types';
import { en } from './en';
import { zhCN } from './zh-CN';

export const DICTS: Record<Locale, Dict> = {
  'zh-CN': zhCN,
  en,
};

export { en, zhCN };
