/**
 * [INPUT]: a structured run failure (`kind` / daemon message / quota reset time).
 * [OUTPUT]: the localized title + body the error card shows.
 * [POS]: Pure formatting layer between the daemon's classification and the chat UI.
 *
 * Why a separate layer: the daemon speaks one language and has no access to the UI locale. It
 * classifies and returns facts (`kind`, `retryAfterAt`); the copy is chosen here, so an English UI
 * shows English even when the agent's own message was Chinese.
 */

import type { ChatRunErrorKind } from '@remixclip/contracts';
import { getLocale, t } from '@/i18n';

export interface RunErrorLike {
  /** Daemon message; used verbatim only when the kind is unknown. */
  message?: string;
  kind?: ChatRunErrorKind;
  detail?: string;
  resetAt?: number | null;
  exitCode?: number | null;
}

/** `18:00` for today, `11/13 09:00` otherwise — never a full ISO string in a chat bubble. */
export function formatResetMoment(at?: number | null): string {
  if (!at) return '';
  const date = new Date(at);
  const time = date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

export function runErrorTitle(error: RunErrorLike): string {
  switch (error.kind) {
    case 'quota':
      return t('runError.quotaTitle');
    case 'rate_limit':
      return t('runError.rateLimitTitle');
    case 'auth':
      return t('runError.authTitle');
    case 'network':
      return t('runError.networkTitle');
    default:
      return t('runError.unknownTitle');
  }
}

/**
 * The card's one-paragraph explanation.
 *
 * `quota` / `rate_limit` / `auth` / `network` are fully localized because these are the failures
 * whose *next step* matters ("充值或等待重置", "先登录"), and those steps must read in the user's
 * language. Everything else keeps the daemon's message, which carries the agent's own words.
 */
export function runErrorText(error: RunErrorLike): string {
  const reset = error.resetAt
    ? t('runError.resetSuffix', { time: formatResetMoment(error.resetAt) })
    : '';
  switch (error.kind) {
    case 'quota':
      return t('runError.quota', { reset });
    case 'rate_limit':
      return t('runError.rateLimit', { reset });
    case 'auth':
      return t('runError.auth');
    case 'network':
      return t('runError.network');
    default:
      return error.message?.trim() || t('runError.unknown');
  }
}

/** Secondary meta line: exit code only, and only when it adds information. */
export function runErrorMeta(error: RunErrorLike): string {
  if (error.exitCode == null) return '';
  return t('runError.exitCode', { code: error.exitCode });
}
