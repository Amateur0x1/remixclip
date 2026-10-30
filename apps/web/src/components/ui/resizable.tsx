/**
 * [INPUT]: The pane primitives of react-resizable-panels.
 * [OUTPUT]: ResizableGroup / ResizablePanel / ResizableHandle with Solid Glass styling.
 * [POS]: Global layout pane primitives, used for "sidebar | main" and "chat | tasks | preview".
 */
'use client';

import * as React from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';

import { cn } from '@/lib/utils';

function ResizableGroup({ className, ...props }: React.ComponentProps<typeof Group>) {
  return <Group className={cn('flex min-h-0 min-w-0', className)} {...props} />;
}

function ResizablePanel({ className, ...props }: React.ComponentProps<typeof Panel>) {
  return <Panel className={cn('min-h-0 min-w-0', className)} {...props} />;
}

function ResizableHandle({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      className={cn(
        // A 1px solid divider + a 4px invisible grab zone on each side: keeps the split boundary
        // crisp without leaving a gap.
        'group/resize relative z-10 flex w-px shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center bg-border/80 outline-none transition-colors',
        'before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-[""]',
        'hover:bg-foreground/35 focus-visible:bg-ring',
        className,
      )}
      {...props}
    />
  );
}

export { ResizableGroup, ResizablePanel, ResizableHandle };
