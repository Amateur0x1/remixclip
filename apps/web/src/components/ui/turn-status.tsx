/**
 * [INPUT]: The global status-shimmer animation and neutral color tokens.
 * [OUTPUT]: TurnStatus—the single line that persists for the whole turn: status dot, what's happening
 *   now, elapsed time, and an optional background-task hint.
 * [POS]: The shared running-state presentation for the message stream tail and the right task panel.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

/** 8 → "8s", 75 → "1m 15s", 3700 → "1h 1m". */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/** Whole seconds elapsed since a moment; keeps counting while mounted. */
function useElapsed(since: number | undefined): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (since === undefined) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [since]);
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/**
 * The line that stops when a turn ends: it is still running (status dot), what it's doing right now
 * (text with a slow shimmer), how long it has run, and an optional background-task count. Present
 * from the first moment to the last, never coming and going with the content above.
 *
 * Under one second no time is reported: "0s" is a number that says nothing.
 */
function TurnStatus({
  label,
  since,
  trailing,
  active = true,
  className,
}: {
  /** What's happening right now, a few words. */
  label?: string;
  /** The moment this turn started (millisecond timestamp). */
  since?: number;
  /** A hint at the end of the line, separate from the status: e.g. how many background tasks run. */
  trailing?: React.ReactNode;
  /** Pass false when the line is kept after the turn ends: text only, no pulsing. */
  active?: boolean;
  className?: string;
}) {
  const elapsed = useElapsed(since);

  return (
    <div data-slot="turn-status" className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex h-5 max-w-full items-center gap-1.5">
        <div role="status" className="flex w-fit max-w-full items-center gap-2 text-[12.5px] text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full bg-foreground/70',
              active && 'animate-pulse',
            )}
          />
          {label && <span className={cn('truncate', active && 'status-shimmer')}>{label}</span>}
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground/80 tabular-nums">
            {elapsed >= 1 && formatDuration(elapsed)}
          </span>
        </div>
        {trailing}
      </div>
    </div>
  );
}

export { TurnStatus, formatDuration, useElapsed };
