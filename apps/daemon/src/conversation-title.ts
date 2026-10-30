/**
 * [INPUT]: UI language tag sent by the frontend (`zh-CN` / `en` / empty).
 * [OUTPUT]: `defaultConversationTitle(locale)` — fallback title for a new conversation.
 * [POS]: Shared default-title source for the runs and conversations routes; covers only the
 *        "user hasn't given a title yet" case — daemon error copy stays Chinese, not extended here.
 */
import { normalizePromptLocale } from '@remixclip/contracts';

/**
 * Default title follows the UI language.
 *
 * With no locale, keep the historical behavior (Chinese), because old clients and script calls
 * don't send this field; everything else is English — a Chinese title is written only for a
 * clearly Chinese UI. The decision goes through `normalizePromptLocale`, so variants like
 * `zh_CN` / `zh-TW` share the same normalization rules as prompt sections, and we never get
 * "prompt says Simplified Chinese, title is English".
 */
export function defaultConversationTitle(locale: string | null | undefined): string {
  if (typeof locale !== 'string' || !locale.trim()) return '新对话';
  return normalizePromptLocale(locale) === 'zh-CN' ? '新对话' : 'New conversation';
}
