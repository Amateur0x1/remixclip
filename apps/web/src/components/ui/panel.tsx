/**
 * [INPUT]: The Solid Glass panel styling (glass-panel) and shared button primitives.
 * [OUTPUT]: Panel (a thin panel with title/actions/close) and PanelRow (a selectable row in a panel).
 * [POS]: Container primitive shared by both workspace columns (sessions, files, background tasks).
 */
'use client';

import * as React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';

/**
 * The thinnest layer of glass in the page layout: a name, optional tools to its right, a close
 * entry, and content. Lighter than a card, so a column of panels never overpowers the body text
 * being read in the center.
 */
function Panel({
  title,
  bar,
  actions,
  onClose,
  closeLabel,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<'section'>, 'title'> & {
  title: string;
  /** Replaces the title when the panel's own controls (e.g. a segmented switch) already say what it is. */
  bar?: React.ReactNode;
  actions?: React.ReactNode;
  /** Without it there is no close button. */
  onClose?: () => void;
  closeLabel?: string;
}) {
  const { t } = useI18n();
  const closeText = closeLabel ?? t('panel.close');
  return (
    <section
      data-slot="panel"
      aria-label={title}
      className={cn('glass-panel flex min-h-0 flex-col overflow-hidden rounded-md', className)}
      {...props}
    >
      <header
        data-slot="panel-header"
        className={cn('flex h-8 shrink-0 items-center gap-0.5 pr-1', bar ? 'pl-1' : 'pl-2.5')}
      >
        {bar ?? <h2 className="mr-auto truncate text-[12.5px] font-medium text-foreground/90">{title}</h2>}
        {actions}
        {onClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${closeText} ${title}`}
            onClick={onClose}
            className="size-6 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </header>
      {children}
    </section>
  );
}

/** A row in a panel list: lights up on pointer hover, and is a small sheet of clear glass when chosen. */
function PanelRow({
  chosen,
  className,
  ...props
}: React.ComponentProps<'button'> & { chosen?: boolean }) {
  return (
    <button
      type="button"
      data-slot="panel-row"
      aria-current={chosen || undefined}
      className={cn(
        'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-[12.5px] text-foreground/85 transition-colors outline-none hover:bg-accent focus-visible:bg-accent [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        chosen && 'glass-chosen text-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** A small icon button in a panel: icon only, no fill, lights up on hover. */
function PanelIconButton({
  label,
  className,
  ...props
}: React.ComponentProps<'button'> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent [&_svg]:size-3.5',
        className,
      )}
      {...props}
    />
  );
}

/** A section heading inside a panel ("Running", "Finished"). */
function PanelCaption({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn('px-3 pb-1 text-[11.5px] text-muted-foreground/80', className)}>{children}</p>
  );
}

export { Panel, PanelRow, PanelIconButton, PanelCaption };
