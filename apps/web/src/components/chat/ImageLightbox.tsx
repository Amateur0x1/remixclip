'use client';

/**
 * [INPUT]: Image URL and file name, close callback.
 * [OUTPUT]: Full-screen image preview dialog.
 * [POS]: Shared dialog for the chat workspace (opened by clicking an attachment thumbnail).
 */
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';

export function ImageLightbox({ image, onClose }: {
  image: { url: string; name: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={Boolean(image)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {image && (
        <DialogContent showCloseButton={false} className="flex max-h-[90vh] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]">
          <DialogHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-2">
            <DialogTitle className="min-w-0 truncate text-sm">{image.name}</DialogTitle>
            <DialogDescription className="sr-only">{t('message.imageLightbox')}</DialogDescription>
            <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label={t('message.closePreview')}>
              <X className="size-4" />
            </Button>
          </DialogHeader>
          <div className="flex max-h-[calc(90vh-49px)] items-center justify-center overflow-auto bg-muted/30 p-4">
            <img src={image.url} alt={image.name} className="max-h-[calc(90vh-81px)] max-w-full rounded-md object-contain" />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
