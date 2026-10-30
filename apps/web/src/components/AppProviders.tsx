'use client';

/**
 * [INPUT]: The i18n provider and the UI primitive provider (Tooltip).
 * [OUTPUT]: A single client-side provider wrapper the server-component layout can wrap children in directly.
 * [POS]: The only client boundary in apps/web/app/layout.tsx; keeps layout a server component.
 */
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n';
import { TooltipProvider } from '@/components/ui/tooltip';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </I18nProvider>
  );
}
