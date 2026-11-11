'use client';

/**
 * [INPUT]: The active workspace view ('chat' | 'library' | 'cuts') and the switch callback.
 * [OUTPUT]: Three sidebar navigation rows — 对话 / 素材库 / 成片库 — active one highlighted.
 * [POS]: Left-side navigation (top of the sidebar, under search). The main-area headers no
 *        longer host a view toggle: each destination is a sidebar control, not a chat header tab.
 *
 * 「对话」 is not a project-scoped thing here: it is just the default view. Picking it keeps the
 * currently open conversation; picking a project / chat from the tree below also returns to chat.
 */
import { Clapperboard, Images, MessageSquare } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export type WorkspaceTab = 'chat' | 'library' | 'cuts';

export function WorkspaceNav({
  value,
  onChange,
}: {
  value: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  const { t } = useI18n();
  const options: { id: WorkspaceTab; label: string; icon: typeof MessageSquare }[] = [
    { id: 'chat', label: t('tabs.chat'), icon: MessageSquare },
    { id: 'library', label: t('tabs.library'), icon: Images },
    { id: 'cuts', label: t('tabs.cuts'), icon: Clapperboard },
  ];
  return (
    <nav aria-label={t('tabs.aria')} className="flex shrink-0 flex-col gap-0.5 px-2">
      {options.map((option) => {
        const active = value === option.id;
        const Icon = option.icon;
        return (
          <button
            key={option.id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(option.id)}
            className={cn(
              'flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-[14px] outline-none transition-colors',
              active
                ? 'glass-chosen font-medium text-foreground'
                : 'font-normal text-foreground/85 hover:bg-secondary focus-visible:bg-secondary',
            )}
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
