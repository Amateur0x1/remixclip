'use client';

/**
 * [INPUT]: detected local agents and the globally selected agent.
 * [OUTPUT]: Right-side settings drawer: connect / switch / test the local agent and pin its model.
 * [POS]: The single settings surface (replaces the old onboarding-style AgentDetectDialog).
 *
 * Agent = GLOBAL (`app-config.agentId`): one CLI drives every project and every chat. Projects
 * are containers managed from the sidebar, so they are not configured here.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentInfo, ConnectionTestResponse } from '@remixclip/contracts';
import {
  Check,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { testConnection } from '@/providers/daemon';
import { useI18n, type DictKey } from '@/i18n';
import { cn } from '@/lib/utils';

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ConnectionTestResponse };

const FAILURE_LABEL_KEY: Record<ConnectionTestResponse['kind'], DictKey> = {
  ok: 'agent.testOk',
  binary: 'agent.testBinary',
  auth: 'agent.testAuth',
  network: 'agent.testNetwork',
  model: 'agent.testModel',
  timeout: 'agent.testTimeout',
  unknown: 'agent.testUnknown',
};

export function SettingsDialog({
  open,
  onClose,
  agents,
  agentsLoading,
  agentId,
  model,
  onRescan,
  onConnectAgent,
  onModelChange,
}: {
  open: boolean;
  onClose: () => void;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentId: string | null;
  model: string;
  onRescan: () => Promise<void>;
  onConnectAgent: (agentId: string, model: string) => Promise<void>;
  onModelChange: (model: string) => void;
}) {
  const { t } = useI18n();
  const availableAgents = useMemo(() => agents.filter((agent) => agent.available), [agents]);
  const unavailableAgents = useMemo(() => agents.filter((agent) => !agent.available), [agents]);

  const [modelDraft, setModelDraft] = useState(model);
  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { setModelDraft(model); }, [model]);
  useEffect(() => { if (!open) { setTestState({ status: 'idle' }); setError(''); } }, [open]);

  const selectedAgent = availableAgents.find((agent) => agent.id === agentId) ?? null;

  const connect = async (agent: AgentInfo) => {
    setConnectingId(agent.id);
    setError('');
    try {
      await onConnectAgent(agent.id, agent.id === agentId ? modelDraft.trim() : '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errors.agentConnect'));
    } finally {
      setConnectingId(null);
    }
  };

  const runTest = async () => {
    if (!selectedAgent || testState.status === 'running') return;
    setTestState({ status: 'running' });
    try {
      const result = await testConnection(selectedAgent.id, modelDraft.trim() || undefined);
      setTestState({ status: 'done', result });
    } catch (err) {
      setTestState({
        status: 'done',
        result: {
          ok: false,
          kind: 'unknown',
          latencyMs: 0,
          detail: err instanceof Error ? err.message : t('agent.requestDaemonFailed'),
        },
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className="left-auto right-0 top-0 flex h-dvh w-[440px] max-w-[calc(100vw-2rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-y-0 border-r-0 bg-background p-0 sm:max-w-[440px]"
      >
        <div data-remixclip-titlebar className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <DialogTitle className="text-[15px] font-semibold text-foreground">{t('settings.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('settings.description')}</DialogDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ml-auto size-7 text-muted-foreground hover:bg-secondary hover:text-foreground"
            aria-label={t('common.close')}
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 [scrollbar-width:thin]">
          {/* ── Agent (global) ─────────────────────────────────────────── */}
          <section aria-label={t('settings.agentSection')}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{t('settings.agentSection')}</h2>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-muted-foreground hover:text-foreground"
                disabled={agentsLoading}
                onClick={() => void onRescan()}
              >
                <RefreshCw className={cn('size-3.5', agentsLoading && 'animate-spin')} aria-hidden="true" />
                {t('agent.rescan')}
              </Button>
            </div>
            <p className="mb-2 text-[12px] leading-5 text-muted-foreground">{t('settings.agentHint')}</p>

            {agentsLoading && availableAgents.length === 0 ? (
              <div className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-[12.5px] text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                {t('agent.scanning')}
              </div>
            ) : availableAgents.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
                <p className="text-[13px] text-foreground">{t('agent.noneTitle')}</p>
                <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{t('agent.noneDesc')}</p>
              </div>
            ) : (
              <ul className="space-y-1" aria-label={t('agent.availableAria')}>
                {availableAgents.map((agent) => {
                  const inUse = agent.id === agentId;
                  const connecting = connectingId === agent.id;
                  return (
                    <li key={agent.id}>
                      <div
                        className={cn(
                          'flex min-w-0 items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
                          inUse ? 'border-foreground/25 bg-secondary' : 'border-border',
                        )}
                      >
                        <AgentIcon id={agent.id} size={20} />
                        <span className="grid min-w-0 flex-1 gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-[13px] font-medium text-foreground">{agent.name}</span>
                            {agent.auth?.status === 'unauthenticated' && (
                              <span className="shrink-0 rounded-full bg-destructive/10 px-1.5 py-px text-[10px] text-destructive">
                                {t('settings.needsLogin')}
                              </span>
                            )}
                          </span>
                          <span className="truncate text-[11.5px] text-muted-foreground" title={agent.path}>
                            {agent.version ?? t('agent.installed')}
                          </span>
                        </span>
                        {inUse ? (
                          <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-muted-foreground">
                            <Check className="size-3.5" aria-hidden="true" />
                            {t('settings.connected')}
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled={connecting}
                            onClick={() => void connect(agent)}
                          >
                            {connecting && <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />}
                            {t('settings.connect')}
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedAgent && (
              <div className="mt-3 rounded-lg border border-border bg-secondary/30 px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                    {t('settings.modelFor', { name: selectedAgent.name })}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="text-foreground"
                    disabled={testState.status === 'running'}
                    onClick={() => void runTest()}
                  >
                    {testState.status === 'running' ? (
                      <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                    ) : (
                      <FlaskConical className="size-3" aria-hidden="true" />
                    )}
                    {testState.status === 'running' ? t('agent.testing') : t('agent.testConnection')}
                  </Button>
                </div>

                <Input
                  className="mt-2"
                  aria-label={t('agent.modelLabel')}
                  value={modelDraft}
                  placeholder={t('settings.modelPlaceholder')}
                  onChange={(event) => {
                    setModelDraft(event.target.value);
                    setTestState({ status: 'idle' });
                  }}
                  onBlur={() => { if (modelDraft !== model) onModelChange(modelDraft.trim()); }}
                />
                {(selectedAgent.models?.length ?? 0) > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="rounded-full border border-border px-2 py-px text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => { setModelDraft(''); onModelChange(''); }}
                    >
                      {t('agent.cliDefault')}
                    </button>
                    {selectedAgent.models!.slice(0, 8).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={cn(
                          'rounded-full border px-2 py-px text-[11px]',
                          modelDraft === preset
                            ? 'border-foreground/30 bg-background text-foreground'
                            : 'border-border text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => {
                          setModelDraft(preset);
                          setTestState({ status: 'idle' });
                          onModelChange(preset);
                        }}
                      >
                        {preset}
                      </button>
                    ))}
                  </div>
                )}

                {selectedAgent.auth?.status === 'unauthenticated' && (
                  <p role="alert" className="mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11.5px] leading-5 text-destructive">
                    {t('agent.notLoggedInPrefix')}
                    <code className="font-mono">{selectedAgent.bin}</code>
                    {t('agent.notLoggedInSuffix')}
                  </p>
                )}

                {testState.status === 'done' && (
                  <p
                    role={testState.result.ok ? 'status' : 'alert'}
                    className={cn(
                      'mt-2 text-[12px] leading-5',
                      testState.result.ok ? 'text-muted-foreground' : 'text-destructive',
                    )}
                  >
                    {testState.result.ok ? '✓ ' : '✕ '}
                    {t(FAILURE_LABEL_KEY[testState.result.kind])}
                    {testState.result.latencyMs > 0
                      ? t('agent.testLatency', { seconds: (testState.result.latencyMs / 1000).toFixed(1) })
                      : ''}
                    {testState.result.detail ? ` · ${testState.result.detail}` : ''}
                  </p>
                )}
              </div>
            )}

            {unavailableAgents.length > 0 && (
              <Collapsible className="mt-3">
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md py-1 text-left text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
                  {t('agent.unavailableCount', { count: unavailableAgents.length })}
                  <span className="text-muted-foreground/70">{t('agent.installThenRescan')}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-1 space-y-0.5">
                    {unavailableAgents.map((agent) => (
                      <li key={agent.id} className="flex items-start gap-2 rounded-md px-1.5 py-1.5">
                        <AgentIcon id={agent.id} size={16} className="mt-0.5 opacity-45" />
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-[12.5px] text-foreground/80">{agent.name}</span>
                            <code className="shrink-0 rounded bg-secondary px-1 py-px font-mono text-[10.5px] text-muted-foreground">
                              {agent.bin}
                            </code>
                            {agent.docsUrl && (
                              <a
                                href={agent.docsUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="ml-auto flex shrink-0 items-center gap-0.5 text-[11.5px] text-link hover:underline"
                              >
                                {t('agent.installDocs')}
                                <ExternalLink className="size-3" aria-hidden="true" />
                              </a>
                            )}
                          </div>
                          <p className="truncate text-[11.5px] text-muted-foreground" title={agent.diagnostic?.detail ?? agent.error}>
                            {agent.diagnostic?.message ?? agent.error ?? t('agent.notInPath')}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </section>

          {error && <p role="alert" className="mt-3 rounded-md bg-secondary p-2 text-[12px] text-foreground">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
