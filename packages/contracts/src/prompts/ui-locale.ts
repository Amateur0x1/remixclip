/**
 * [INPUT]: The UI language tag sent by the frontend (`zh-CN` / `en`, also tolerating variants such
 *          as `en-US`, `zh_CN`).
 * [OUTPUT]: `normalizePromptLocale` / `promptLanguageName` / `PROMPT_LOCALE_EXEMPT_TERMS_SENTENCE`.
 * [POS]: Prompt fragment shared at the protocol layer; the daemon and any future local runner take it
 *         from here, avoiding the "answer in the user's language" sentence being written in several
 *         places and drifting over time.
 */

/**
 * Normalize a UI language into the language to inject into the prompt, or null.
 *
 * Two cases return null:
 * - Not provided / empty string: the caller has no opinion, so the sentence is not written;
 * - English UI: the prompt itself is English, and adding another "Respond in English" is a
 *   zero-information rule — it only changes the byte count of every prompt and invalidates the
 *   upstream prefix cache entirely.
 *
 * Chinese is handled as Simplified: this project currently only ships zh-CN, and Traditional users
 * land on the same copy, so `zh-TW` / `zh_HK` are normalized to `zh-CN` too instead of passing the
 * tag through and letting the model guess which glyph set to use.
 */
export function normalizePromptLocale(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string') return null;
  const tag = locale.trim();
  if (!tag) return null;
  if (/^en([-_]|$)/i.test(tag)) return null;
  if (/^zh([-_]|$)/i.test(tag)) return 'zh-CN';
  return tag;
}

/**
 * Normalized tag -> language name written into the prompt.
 *
 * Only `zh-CN` needs expanding: to the model `zh-CN` is ambiguous about "which Chinese" while
 * `Simplified Chinese` is not. Other tags are passed to the model as-is with no speculative translation.
 */
export function promptLanguageName(normalized: string): string {
  return normalized === 'zh-CN' ? 'Simplified Chinese' : normalized;
}

/**
 * The same boundary every locale segment must carry: translation only applies to natural-language prose,
 * brand names / code / technical identifiers stay as-is, and the user's explicit request about the
 * output language always wins.
 * Exported separately so all call sites reference the same string instead of copying it.
 */
export const PROMPT_LOCALE_EXEMPT_TERMS_SENTENCE =
  "Keep brand names, file paths, code, and technical identifiers exactly as they are, and always follow the user's explicit request about the output language.";
