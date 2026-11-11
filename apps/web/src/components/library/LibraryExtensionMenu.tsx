'use client';

/**
 * [INPUT]: a trigger element plus the daemon's companion package metadata (shared download hook).
 * [OUTPUT]: a compact dropdown holding the download action, version/size, and download status.
 * [POS]: The library's "get the browser companion" entry point — one action in a menu instead of a
 *        multi-section dialog.
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Download, LoaderCircle } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatSize } from '@/components/chat/chat-types';
import { useI18n } from '@/i18n';
import { useExtensionPackage } from './useExtensionPackage';

export function LibraryExtensionMenu({
  children,
  align = 'end',
}: {
  children: ReactNode;
  align?: 'start' | 'end';
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Metadata is read on every open, so a rebuild between opens is picked up exactly when the
  // user is about to click download.
  const { info, loading, downloading, error, downloadedFile, download } = useExtensionPackage(open);
  const available = info?.available ?? false;
  const blocked = loading || downloading || (info != null && !available);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-60">
        <DropdownMenuItem
          disabled={blocked}
          // Keep the menu open so 「打包中…」 and the failure notice stay visible.
          onSelect={(event) => {
            event.preventDefault();
            void download();
          }}
          className="flex-col items-start gap-0.5 py-2"
        >
          <span className="flex items-center gap-2 text-[12.5px] font-medium">
            {downloading
              ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              : <Download className="size-3.5" aria-hidden="true" />}
            {downloading ? t('library.ext.downloading') : t('library.ext.download')}
          </span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {available && info?.version
              ? t('library.ext.meta', {
                  version: info.version,
                  size: info.size == null ? '—' : formatSize(info.size),
                })
              : loading
                ? t('library.loading')
                : t('library.ext.missing')}
          </span>
        </DropdownMenuItem>

        {(error || downloadedFile) && (
          <p
            role={error ? 'alert' : 'status'}
            className="px-2 pb-1 pt-1.5 text-[11px] leading-4 text-muted-foreground"
          >
            {error ?? t('library.ext.downloaded', { file: downloadedFile ?? '' })}
          </p>
        )}

        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] leading-4 text-muted-foreground/80">{t('library.ext.installHint')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
