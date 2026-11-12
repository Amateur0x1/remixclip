'use client';

/**
 * [INPUT]: a structured run failure (kind / message / detail / quota reset time).
 * [OUTPUT]: the chat's failure card — one icon + one actionable sentence, raw output folded away.
 * [POS]: Shared by the live turn (ChatConversationPane) and the settled/replayed message
 *        (MessageView), so a quota exhaustion looks identical before and after a reload.
 *
 * Product decision: the exit code is never the headline. It is a mono footnote, and only when the
 * daemon actually got one. What the user needs first is the *kind* and the *next step* — the old
 * single-line "错误：agent 退出码 1" gave neither.
 */

import { useState } from 'react';
import { ChevronRight, CircleAlert, Coins, Gauge, LogIn, WifiOff } from 'lucide-react';
import type { ChatRunErrorKind } from '@remixclip/contracts';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { runErrorMeta, runErrorText, runErrorTitle, type RunErrorLike } from '@/runtime/chat/run-error';

const KIND_ICON: Record<ChatRunErrorKind, typeof CircleAlert> = {
  quota: Coins,
  rate_limit: Gauge,
  auth: LogIn,
  network: WifiOff,
  agent: CircleAlert,
  unknown: CircleAlert,
};

export function RunErrorNotice({
  error,
  className,
}: {
  error: RunErrorLike;
  className?: string;
}) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);
  const Icon = KIND_ICON[error.kind ?? 'unknown'];
  const meta = runErrorMeta(error);
  const raw = error.detail?.trim();

  return (
    <div
      role="alert"
      className={cn(
        'mt-2 w-full max-w-[820px] overflow-hidden rounded-lg border border-destructive/25 bg-destructive/[0.06]',
        className,
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{runErrorTitle(error)}</p>
          <p className="mt-0.5 text-[12.5px] leading-5 text-muted-foreground">{runErrorText(error)}</p>
          {(meta || raw) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4">
              {meta && <span className="font-mono text-muted-foreground/70">{meta}</span>}
              {raw && (
                <button
                  type="button"
                  onClick={() => setShowRaw((value) => !value)}
                  aria-expanded={showRaw}
                  className="inline-flex items-center gap-0.5 text-muted-foreground/80 transition-colors hover:text-foreground"
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform', showRaw && 'rotate-90')}
                    aria-hidden="true"
                  />
                  {t('runError.rawOutput')}
                </button>
              )}
            </div>
          )}
          {showRaw && raw && (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background/70 px-2.5 py-2 font-mono text-[11px] leading-4 text-muted-foreground">
              {raw}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
