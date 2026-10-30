'use client';

/**
 * [INPUT]: Plain-text Markdown content, react-markdown and the remark-gfm plugin.
 * [OUTPUT]: Code blocks with a copy button and a CommonMark/GFM rich-text renderer component.
 * [POS]: Markdown rendering layer shared by chat messages and subagent output.
 */
import { memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { openExternalUrl } from '@/providers/daemon';

function MarkdownCodeBlock({ children, language, text }: { children: ReactNode; language?: string; text: string }) {
  const { t } = useI18n();
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (copyStatus === 'idle') return;
    const timer = setTimeout(() => setCopyStatus('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ''));
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    }
  };
  return (
    <div className="chat-code-block">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" title={language}>{language || t('markdown.code')}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground"
          onClick={() => void copy()}
          aria-label={copyStatus === 'failed' ? t('markdown.copyFailedAria') : t('markdown.copyCode')}
        >
          {copyStatus === 'copied' ? <Check className="size-3" aria-hidden="true" /> : <Copy className="size-3" aria-hidden="true" />}
          <span aria-live="polite">{copyStatus === 'copied' ? t('common.copied') : copyStatus === 'failed' ? t('markdown.copyFailed') : t('markdown.copy')}</span>
        </Button>
      </div>
      <pre tabIndex={0} aria-label={language ? t('markdown.codeLangAria', { language }) : t('markdown.codeAria')}>{children}</pre>
    </div>
  );
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="chat-markdown-table" role="region" aria-label={t('markdown.tableAria')} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children, title }) =>
    href ? (
      <a
        href={href}
        title={title}
        target={href.startsWith('#') ? undefined : '_blank'}
        rel="noopener noreferrer"
        onClick={(event) => {
          if (/^https?:\/\//i.test(href)) {
            event.preventDefault();
            void openExternalUrl(href);
          }
        }}
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt, title }) =>
    src
      ? <img src={src} alt={alt ?? ''} title={title} loading="lazy" />
      : <span>{alt}</span>,
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
  pre: ({ node, children }) => {
    const code = node?.children.find((child) => child.type === 'element' && child.tagName === 'code');
    const classes = code?.type === 'element' ? code.properties.className : undefined;
    const language = (Array.isArray(classes) ? classes.map(String) : []).find((name) => name.startsWith('language-'))?.slice(9);
    const text = code?.type === 'element' ? code.children.map((child) => (child.type === 'text' ? child.value : '')).join('') : '';
    return <MarkdownCodeBlock language={language} text={text}>{children}</MarkdownCodeBlock>;
  },
};

/** Tolerates loose syntax common in CJK docs (e.g. `1.**title**` without a space, `##title` without a space); only applies outside fenced code blocks. */
function normalizeMarkdown(raw: string): string {
  if (!raw) return raw;
  const lines = raw.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    lines[i] = line
      .replace(/^(\s*\d+\.)(?=[^\s\d])/, '$1 ')
      .replace(/^(\s*#{1,6})(?=[^\s#])/, '$1 ');
  }
  return lines.join('\n');
}

/** CommonMark + GFM; skips raw HTML and keeps the library's built-in safe URL filtering. */
export const MarkdownContent = memo(function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div className={cn('chat-markdown', className)} data-remixclip-markdown>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} skipHtml>
        {normalizeMarkdown(content)}
      </ReactMarkdown>
    </div>
  );
});
