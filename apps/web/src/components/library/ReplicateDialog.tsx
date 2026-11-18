'use client';

/**
 * [INPUT]: A library item, detected CLIs, the shared download feed and optional guidance.
 * [OUTPUT]: Mandatory explicit CLI selection (never preselected), local-source preparation and
 *           an awaited recreation handoff; failures keep the dialog open.
 * [POS]: Confirmation boundary between a library card and a CLI-backed recreation project.
 */
import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, LibraryItemSummary, MediaFileStatus } from '@remixclip/contracts';
import { LoaderCircle } from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useDownloads } from './DownloadsCenter';
import { getLibraryShots } from '@/providers/library';
import { useI18n } from '@/i18n';

export function ReplicateDialog({
  item,
  agents,
  agentsLoading,
  onOpenSettings,
  onClose,
  onProceed,
}: {
  item: LibraryItemSummary | null;
  agents: AgentInfo[];
  agentsLoading: boolean;
  onOpenSettings: () => void;
  onClose: () => void;
  /** Only an explicit CLI selection may proceed; rejection leaves this dialog open. */
  onProceed: (guidance: string, agentId: string) => Promise<void>;
}) {
  const { entryFor, start } = useDownloads();
  const { t } = useI18n();
  const [guidance, setGuidance] = useState('');
  const [agentId, setAgentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submittingRef = useRef(false);
  const availableAgents = agents.filter((agent) => agent.available);
  const selectedAgent = availableAgents.find((agent) => agent.id === agentId);
  const canProceed = !agentsLoading && Boolean(selectedAgent);
  /** Media status straight from the item, for sources downloaded outside the feed's window. */
  const [probed, setProbed] = useState<MediaFileStatus | null>(null);
  const [probeSettled, setProbeSettled] = useState(false);
  const itemId = item?.id ?? null;

  // A fresh dialog must not inherit guidance or silently reuse a CLI from the previous item.
  useEffect(() => { setGuidance(''); setAgentId(''); setError(''); }, [itemId]);

  // The download feed only covers active work plus roughly a day of results, so a clip downloaded
  // earlier has no entry there. Ask the item itself instead of downloading it again.
  useEffect(() => {
    setProbed(null);
    setProbeSettled(false);
    if (!itemId) return;
    let cancelled = false;
    void getLibraryShots(itemId)
      .then((data) => { if (!cancelled) setProbed(data.media?.status ?? null); })
      .catch(() => { if (!cancelled) setProbed(null); })
      .finally(() => { if (!cancelled) setProbeSettled(true); });
    return () => { cancelled = true; };
  }, [itemId]);

  const entry = itemId ? entryFor(itemId) : undefined;
  const status = entry?.media.status ?? probed ?? undefined;
  const ready = status === 'ready';
  const running = status === 'pending' || status === 'downloading';
  const failed = status === 'failed';
  const percent = Math.round((entry?.media.progress ?? 0) * 100);
  const checking = !entry && !probeSettled;

  const download = () => {
    if (!itemId) return;
    void start(itemId).catch(() => {});
  };

  const close = () => {
    if (!submittingRef.current) onClose();
  };

  const proceed = async () => {
    if (!ready || !canProceed || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setError('');
    try {
      await onProceed(guidance.trim(), agentId);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('errors.createRun'));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(item)} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t('library.replicateDialogTitle')}</DialogTitle>
          <DialogDescription>
            {t('library.replicateDialogDesc', { title: item?.title || t('library.untitled') })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="replicate-agent" className="text-xs font-medium text-foreground">
            {t('library.replicateAgentLabel')}
          </label>
          <Select value={selectedAgent ? agentId : ''} onValueChange={setAgentId} disabled={agentsLoading || busy || !availableAgents.length}>
            <SelectTrigger id="replicate-agent" aria-required="true" className="w-full">
              <SelectValue placeholder={agentsLoading ? t('sidebar.detecting') : t('library.replicateAgentPlaceholder')} />
            </SelectTrigger>
            <SelectContent>
              {availableAgents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  <AgentIcon id={agent.id} size={16} />
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-4 text-muted-foreground">{t('library.replicateAgentHint')}</p>
          {!agentsLoading && !availableAgents.length && (
            <div role="status" className="rounded-md border border-border/70 bg-secondary/40 px-3 py-2">
              <p className="text-xs leading-5 text-muted-foreground">{t('agent.noneDesc')}</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => { close(); onOpenSettings(); }}>
                {t('sidebar.connectAgent')}
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <label htmlFor="replicate-guidance" className="text-xs font-medium text-foreground">
            {t('library.replicateGuidanceLabel')}
          </label>
          <Textarea
            id="replicate-guidance"
            rows={3}
            disabled={busy}
            value={guidance}
            placeholder={t('library.replicateGuidancePlaceholder')}
            onChange={(event) => setGuidance(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void proceed();
              }
            }}
            className="min-h-[74px] resize-none text-[13px] leading-5"
          />
          <p className="text-[11px] leading-4 text-muted-foreground">
            {t('library.replicateGuidanceHint')}
          </p>
        </div>

        {!ready && !checking && (
          <div className="rounded-md border border-border/70 bg-secondary/40 px-3 py-2">
            <p className="text-[11.5px] leading-4 text-muted-foreground">
              {failed ? t('library.replicateSourceFailed') : t('library.replicateSourcePending')}
            </p>
            {running && (
              <div className="mt-2 flex items-center gap-2">
                <span className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-primary/70 transition-[width] duration-500"
                    style={{ width: `${status === 'pending' ? 4 : percent}%` }}
                  />
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{percent}%</span>
              </div>
            )}
            {failed && entry?.media.error && (
              <p className="mt-1 truncate text-[11px] text-status-interrupted" title={entry.media.error}>
                {entry.media.error}
              </p>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-xs leading-5 text-status-interrupted">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>
            {t('common.cancel')}
          </Button>
          {checking ? (
            <Button type="button" disabled>{t('library.replicateCheckingSource')}</Button>
          ) : ready ? (
            <Button type="button" disabled={!canProceed || busy} onClick={() => void proceed()}>
              {busy && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
              {t('library.replicateStart')}
            </Button>
          ) : (
            <Button type="button" disabled={running} onClick={download}>
              {running ? t('library.replicateDownloading', { percent }) : t('library.replicateDownloadNow')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
