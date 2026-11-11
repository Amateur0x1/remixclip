'use client';

/**
 * [INPUT]: One artifact target (conversation id, project-relative path, optional kind/size/mtime).
 * [OUTPUT]: A modal previewer that dispatches video / image / audio / HTML / markdown / text /
 *           code / PDF, and degrades to a download row for anything else.
 * [POS]: The single viewer behind both the message artifact list and the conversation folder panel;
 *        video URLs go through the daemon's Range-capable file endpoint so seeking works natively.
 */
import { useEffect, useState } from 'react';
import type { WorkspaceFileKind } from '@remixclip/contracts';
import { workspaceFileKind } from '@remixclip/contracts';
import { CircleAlert, Download, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './MarkdownContent';
import { artifactFileUrl, artifactIcon, formatSize, type ArtifactTarget } from './chat-types';

/** Text previews above this size are download-only: fetching a 50 MB log would freeze the tab. */
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

type TextState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'error' };

const TEXT_KINDS: ReadonlySet<WorkspaceFileKind> = new Set(['html', 'markdown', 'text', 'code']);

export function ArtifactPreviewDialog({
  target,
  onClose,
}: {
  target: ArtifactTarget | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [textState, setTextState] = useState<TextState>({ status: 'idle' });
  const [mediaBroken, setMediaBroken] = useState(false);

  const kind: WorkspaceFileKind = target
    ? target.kind ?? workspaceFileKind(target.path)
    : 'other';
  const url = target ? artifactFileUrl(target.conversationId, target.path, target.mtimeMs) : '';
  const name = target?.name ?? target?.path.split('/').pop() ?? '';
  const Icon = artifactIcon(target?.path ?? '');

  useEffect(() => {
    setTextState({ status: 'idle' });
    setMediaBroken(false);
    if (!target || !TEXT_KINDS.has(kind)) return;
    if (target.size && target.size > MAX_TEXT_PREVIEW_BYTES) return;

    const controller = new AbortController();
    setTextState({ status: 'loading' });
    void (async () => {
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        setTextState({ status: 'ready', text });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setTextState({ status: 'error' });
      }
    })();
    return () => controller.abort();
  }, [target, kind, url]);

  const tooLarge = Boolean(target?.size && target.size > MAX_TEXT_PREVIEW_BYTES);

  const body = () => {
    if (!target) return null;
    if (kind === 'video') {
      if (mediaBroken) return <FallbackDownload name={name} url={url} />;
      return (
        <video
          key={url}
          src={url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          className="max-h-full max-w-full rounded-md bg-black shadow-sm"
          onError={() => setMediaBroken(true)}
        />
      );
    }
    if (kind === 'image') {
      if (mediaBroken) return <FallbackDownload name={name} url={url} />;
      return (
        <img
          src={url}
          alt={name}
          className="max-h-full max-w-full rounded-md object-contain"
          onError={() => setMediaBroken(true)}
        />
      );
    }
    if (kind === 'audio') {
      if (mediaBroken) return <FallbackDownload name={name} url={url} />;
      return (
        <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-lg border bg-card p-5">
          <Icon className="size-8 text-muted-foreground" aria-hidden="true" />
          <audio key={url} src={url} controls className="w-full" onError={() => setMediaBroken(true)} />
        </div>
      );
    }
    if (kind === 'pdf') {
      return <iframe className="size-full border-0 bg-white" src={url} title={name} />;
    }
    if (TEXT_KINDS.has(kind)) {
      if (tooLarge) {
        return (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <Icon className="size-8" aria-hidden="true" />
            <p>{t('artifacts.tooLarge')}</p>
            <DownloadButton name={name} url={url} />
          </div>
        );
      }
      if (textState.status === 'loading' || textState.status === 'idle') {
        return <LoaderCircle className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />;
      }
      if (textState.status === 'error') {
        return (
          <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
            <CircleAlert className="size-7" aria-hidden="true" />
            <p>{t('artifacts.loadTextFailed')}</p>
            <DownloadButton name={name} url={url} />
          </div>
        );
      }
      if (kind === 'html') {
        return (
          <iframe
            className="size-full border-0 bg-white"
            sandbox="allow-scripts"
            srcDoc={textState.text}
            title={name}
          />
        );
      }
      if (kind === 'markdown') {
        return (
          <div className="size-full overflow-auto px-5 py-4 text-sm leading-7">
            <MarkdownContent content={textState.text} />
          </div>
        );
      }
      return (
        <pre className="size-full overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
          {textState.text}
        </pre>
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
        <Icon className="size-8" aria-hidden="true" />
        <p>{t('artifacts.previewUnavailable')}</p>
        <DownloadButton name={name} url={url} />
      </div>
    );
  };

  const fills = kind === 'html' || kind === 'pdf' || kind === 'markdown' || kind === 'text' || kind === 'code';

  return (
    <Dialog open={Boolean(target)} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target && (
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(760px,88vh)] w-[min(1080px,92vw)] max-w-[92vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1080px]"
        >
          <DialogHeader className="flex flex-row items-center gap-2 border-b border-border px-4 py-2">
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-sm font-medium" title={target.path}>{name}</DialogTitle>
              <DialogDescription className="truncate text-[11px] text-muted-foreground" title={target.path}>
                {target.path}
                {typeof target.size === 'number' ? ` · ${formatSize(target.size)}` : ''}
              </DialogDescription>
            </div>
            <DownloadButton name={name} url={url} />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label={t('message.closePreview')}
            >
              <X className="size-4" />
            </Button>
          </DialogHeader>
          <div
            className={cn(
              'flex min-h-0 flex-1 justify-center overflow-auto bg-muted/30',
              fills ? 'items-stretch p-0' : 'items-center p-4',
            )}
          >
            {body()}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function DownloadButton({ name, url }: { name: string; url: string }) {
  const { t } = useI18n();
  return (
    <Button asChild type="button" variant="ghost" size="icon-sm" title={t('artifacts.download')}>
      <a href={url} download={name} aria-label={t('artifacts.download')}>
        <Download className="size-4" aria-hidden="true" />
      </a>
    </Button>
  );
}

function FallbackDownload({ name, url }: { name: string; url: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-3 text-sm text-muted-foreground">
      <CircleAlert className="size-7" aria-hidden="true" />
      <p>{t('artifacts.previewUnavailable')}</p>
      <DownloadButton name={name} url={url} />
    </div>
  );
}
