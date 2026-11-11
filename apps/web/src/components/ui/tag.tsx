/**
 * [INPUT]: Solid Glass glass-chosen / glass-armed glass tag styling and icons.
 * [OUTPUT]: Tag component (file/context tags mounted in the input area and messages, with upload progress and Backspace armed state).
 * [POS]: Attachment tag primitive for the Composer and user messages.
 */
'use client';

import * as React from 'react';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

function Tag({
  icon,
  progress,
  error,
  armed,
  onRemove,
  removeLabel,
  className,
  children,
  ...props
}: React.ComponentProps<'span'> & {
  icon?: React.ReactNode;
  /** 0–1 is upload progress; omit once done. */
  progress?: number;
  /** Error reason (shown on hover, tag turns the error color). */
  error?: string;
  armed?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const { t } = useI18n();
  const removeText = removeLabel ?? t('tag.remove');
  const going = progress !== undefined && !error;
  const percent = Math.round((progress ?? 0) * 100);
  return (
    <span
      data-slot="tag"
      title={error}
      className={cn(
        'glass-chosen relative flex h-7 w-fit max-w-48 items-center gap-1.5 overflow-hidden rounded-sm pl-2 text-[12px] text-foreground/90 [&_svg]:size-3.5 [&_svg]:shrink-0',
        onRemove ? 'pr-1' : 'pr-2',
        error && 'text-destructive',
        armed && 'glass-armed',
        className,
      )}
      {...props}
    >
      {going && (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      )}
      <span className={cn('relative flex', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ? <X /> : going ? <Loader2 className="animate-spin" /> : icon}
      </span>
      <span className="relative truncate">{children}</span>
      {going && (
        <span className="relative min-w-[4ch] shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">
          {percent}%
        </span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeText}
          onClick={onRemove}
          className="relative shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&_svg]:size-3"
        >
          <X />
        </button>
      )}
    </span>
  );
}

export { Tag };
