/**
 * [INPUT]: Global border / muted-foreground styling.
 * [OUTPUT]: Small keycap-style blocks (Kbd / KbdGroup): transparent fill + thin stroke, icons from lucide
 *   svg.
 * [POS]: Shared primitive for keyboard-shortcut hints, used in the search row and similar spots.
 */
import * as React from 'react';
import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border border-border/70 bg-transparent px-1 font-sans text-xs font-medium text-muted-foreground select-none [&_svg:not([class*=\'size-\'])]:size-3',
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="kbd-group" className={cn('inline-flex items-center gap-1', className)} {...props} />;
}

export { Kbd, KbdGroup };
