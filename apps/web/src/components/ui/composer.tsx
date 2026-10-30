/**
 * [INPUT]: Solid Glass input-area styling, shared Button / DropdownMenu primitives.
 * [OUTPUT]: Composer (writing surface + send/stop), footer layout and ComposerPick (mode/model choice).
 * [POS]: Workspace bottom input area; message content is layered apart from "how it gets sent",
 * keeping settings out of the writing surface.
 */
import * as React from 'react';
import { ArrowUp, ChevronDown, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * Where messages are written: a pane of glass holding what's available before typing (leading:
 * attach button), what's already attached (tags), the body, and the send mark.
 *
 * The send mark has no background in any state: the button is the mark itself, and its brightness
 * says what it will do. As bright as the body when sendable; dimmed when empty; when a turn is
 * running with no new content, it's a quiet square that stops the turn. Enter sends, Shift+Enter
 * inserts a newline.
 */
function Composer({
  value,
  onValueChange,
  onSubmit,
  onStop,
  running = false,
  disabled = false,
  placeholder,
  textareaProps,
  leading,
  tags,
  above,
  canSubmit,
  onBackspaceAtStart,
  onAttachFiles,
  /** Lets the caller grab the body node for focus and selection handling. */
  textareaRef,
  sendLabel,
  stopLabel,
  className,
  ...props
}: Omit<React.ComponentProps<'div'>, 'onSubmit'> & {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** Only takes over naming-related attributes; other HTML attributes belong to the outer container. */
  textareaProps?: Pick<
    React.ComponentProps<'textarea'>,
    'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'
  >;
  leading?: React.ReactNode;
  tags?: React.ReactNode;
  /** Above the body: images etc. sent along with the message. */
  above?: React.ReactNode;
  /** Whether there is content to send. Defaults to whether the body is non-empty. */
  canSubmit?: boolean;
  /** Returning true means the key press was consumed and no longer reaches the body. */
  onBackspaceAtStart?: () => boolean;
  /** Fires when a screenshot/file is pasted or files are dragged into the input area. */
  onAttachFiles?: (files: File[]) => void;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  sendLabel?: string;
  stopLabel?: string;
}) {
  const { t } = useI18n();
  const textarea = React.useRef<HTMLTextAreaElement | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const ready = canSubmit ?? value.trim().length > 0;
  // While a turn is running the mark stops it — unless content has been typed, then it queues after the turn.
  const stops = running && !ready;
  const Icon = stops ? Square : ArrowUp;

  const resize = React.useCallback(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  React.useLayoutEffect(resize, [value, resize]);
  React.useLayoutEffect(() => {
    const el = textarea.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Sidebar and attachments change wrapping but not the body; observe width only to avoid a
    // height write-back loop.
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      resize();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [resize]);

  const submit = () => {
    if (!ready || disabled) return;
    onSubmit?.(value);
  };

  return (
    <div
      data-slot="composer"
      onDragOver={(event) => {
        if (!onAttachFiles || disabled) return;
        if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragOver(false);
        }
      }}
      onDrop={(event) => {
        if (!onAttachFiles || disabled) return;
        setDragOver(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length > 0) {
          event.preventDefault();
          onAttachFiles(files);
        }
      }}
      className={cn(
        'group/composer relative rounded-xl bg-card py-2 pr-1 pl-2 transition-colors focus-within:border-ring/60',
        dragOver && 'border-ring ring-2 ring-ring/30',
        className,
      )}
      {...props}
    >
      {above && <div className="flex flex-wrap gap-1.5 px-1 pt-0.5 pb-2">{above}</div>}
      {/* items-end keeps both controls on the last line as the box grows; at one line both are 32px, looking centered. */}
      <div className="flex flex-wrap items-end gap-1">
        {leading}
        {tags}
        <div className={cn('flex min-w-48 flex-1 items-end gap-1', Boolean(tags) && 'ml-1.5', !leading && !tags && 'pl-1.5')}>
          <textarea
            {...textareaProps}
            ref={(node) => {
              textarea.current = node;
              if (typeof textareaRef === 'function') textareaRef(node);
              else if (textareaRef && typeof textareaRef === 'object') {
                (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
              }
            }}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(event) => onValueChange(event.target.value)}
            onPaste={(event) => {
              if (!onAttachFiles || disabled) return;
              const items = Array.from(event.clipboardData?.items ?? []);
              const files = items
                .filter((item) => item.kind === 'file')
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length === 0 && event.clipboardData?.files?.length) {
                files.push(...Array.from(event.clipboardData.files));
              }
              if (files.length > 0) {
                const plainText = event.clipboardData?.getData('text/plain') ?? '';
                if (!plainText || files.some((file) => file.name === plainText.trim())) {
                  event.preventDefault();
                }
                onAttachFiles(files);
              }
            }}
            onCompositionStart={() => {
              // IME composition state is read from the textarea's isComposing / keyCode 229; nothing to store here.
            }}
            onKeyDown={(event) => {
              // The Enter used by an IME to commit candidates belongs to the IME, not to sending.
              // Safari only reports this key after composition ends, so it can only be detected via keyCode 229.
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (
                event.key === 'Backspace' &&
                event.currentTarget.selectionStart === 0 &&
                event.currentTarget.selectionEnd === 0 &&
                onBackspaceAtStart?.()
              ) {
                event.preventDefault();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            className={cn(
              // Keep the placeholder on one line: wrapping makes the empty box two lines tall.
              'scrollbar-thin max-h-50 min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-6 text-foreground outline-none placeholder:overflow-hidden placeholder:text-ellipsis placeholder:whitespace-nowrap placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60',
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={stops ? stopLabel ?? t('composer.stop') : sendLabel ?? t('composer.send')}
            disabled={!stops && (!ready || disabled)}
            onClick={stops ? onStop : submit}
            className={cn(
              'shrink-0 rounded-md bg-transparent transition-colors hover:bg-accent',
              stops
                ? 'text-muted-foreground hover:text-foreground'
                : ready && !disabled
                  ? 'text-foreground'
                  : 'text-muted-foreground/50 hover:bg-transparent disabled:opacity-100',
            )}
          >
            <Icon className={cn('size-4', stops && 'size-2.5 fill-current')} />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A row below the input area rather than squeezed inside it: these are message settings, not body. */
function ComposerFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="composer-footer"
      className={cn('mt-1 flex items-center gap-1 pr-[9px] pl-2.5 [&>[data-slot=composer-footer-end]]:ml-auto', className)}
      {...props}
    />
  );
}

function ComposerFooterEnd({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="composer-footer-end" className={cn('flex items-center gap-0.5', className)} {...props} />;
}

/**
 * Pick one of a few options and show the current value: mode, model, thinking effort.
 * Stays highlighted while the menu is open, consistent with other controls that have menus.
 */
function ComposerPick<T extends string>({
  label,
  value,
  options,
  onValueChange,
  shown,
  align = 'end',
  disabled = false,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onValueChange: (value: T) => void;
  /** Text shown on the trigger; defaults to the selected option's label. */
  shown?: string;
  align?: 'start' | 'end';
  disabled?: boolean;
}) {
  const explained = options.some((option) => option.hint);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        disabled={disabled}
        className="glass-held flex h-6 items-center gap-1 rounded-sm px-1.5 text-[12px] text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:text-foreground aria-expanded:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="max-w-40 truncate">{shown ?? options.find((option) => option.value === value)?.label ?? label}</span>
        <ChevronDown className="size-3 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align={align} className={explained ? 'w-72' : 'min-w-36'}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onValueChange(next as T)}>
          {/* Placed inside the group: a label outside the group has nothing to name. */}
          <DropdownMenuLabel className="text-[11px]">{label}</DropdownMenuLabel>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className={cn('text-[13px]', option.hint && 'items-start py-1.5')}
            >
              {option.hint ? (
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-[12px] leading-snug whitespace-normal text-muted-foreground">{option.hint}</span>
                </span>
              ) : (
                option.label
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { Composer, ComposerFooter, ComposerFooterEnd, ComposerPick };
