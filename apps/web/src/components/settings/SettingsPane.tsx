'use client';

/**
 * [INPUT]: detected local agents, the globally selected agent, the companion package metadata,
 *          and the current UI locale.
 * [OUTPUT]: A full main-area page laid out as setting rows (label + value on the left, control on
 *           the right): local agent, companion download + its port, and the language selector.
 * [POS]: A workspace destination (not an overlay): opening settings replaces the main pane the
 *        same way the library tab does, and the sidebar entry toggles it.
 *
 * Agent = GLOBAL (`app-config.agentId`): one CLI drives every project and every chat. Projects
 * are containers managed from the sidebar, so they are not configured here. The companion is a
 * browser extension, so it is not per project either — one download serves the whole app.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import type { AgentInfo, ConnectionTestResponse, DaemonRuntimeInfo } from '@remixclip/contracts';
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FlaskConical,
  LoaderCircle,
  PanelLeftOpen,
  RefreshCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { AgentIcon } from '@/components/agents/AgentIcon';
import { formatSize } from '@/components/chat/chat-types';
import { useExtensionPackage } from '@/components/library/useExtensionPackage';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchDaemonInfo, testConnection } from '@/providers/daemon';
import { LOCALES, LOCALE_LABEL, useI18n, type DictKey, type Locale } from '@/i18n';
import { cn } from '@/lib/utils';

type TestState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: ConnectionTestResponse };

const FAILURE_LABEL_KEY: Record<ConnectionTestResponse['kind'], DictKey> = {
  ok: 'agent.testOk',
  binary: 'agent.testBinary',
  auth: 'agent.testAuth',
  quota: 'agent.testQuota',
  rate_limit: 'agent.testRateLimit',
  network: 'agent.testNetwork',
  model: 'agent.testModel',
  timeout: 'agent.testTimeout',
  unknown: 'agent.testUnknown',
};

/** One titled group of rows, separated by hairlines — the platform settings list look. */
function SettingsSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2 px-1">
        <h2 className="text-[11.5px] font-medium tracking-wide text-muted-foreground">{label}</h2>
        {action}
      </div>
      {/*
        Flat outline only. `bg-card` is the thick glass pane; a bare bordered box
        with no fill is promoted to the thin panel pane (solid-glass.css). Either
        way the group sits on a glass layer, so name the fill explicitly:
        `bg-transparent` is not a pane, leaving just the hairline outline.
      */}
      <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border bg-transparent">
        {children}
      </div>
    </section>
  );
}

export function SettingsPane({
  onClose,
  sidebarCollapsed,
  sidebarCompact,
  sidebarDrawerOpen,
  setSidebarCollapsed,
  setSidebarDrawerOpen,
  sidebarToggleRef,
  agents,
  agentsLoading,
  agentId,
  model,
  onRescan,
  onConnectAgent,
}: {
  onClose: () => void;
  sidebarCollapsed: boolean;
  sidebarCompact: boolean;
  sidebarDrawerOpen: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarDrawerOpen: (open: boolean) => void;
  sidebarToggleRef: RefObject<HTMLButtonElement>;
  agents: AgentInfo[];
  agentsLoading: boolean;
  agentId: string | null;
  /** The model currently picked in the chat composer; the connection test runs with it. */
  model: string;
  onRescan: () => Promise<void>;
  /** Only the agent is global here: the model is picked per turn in the composer. */
  onConnectAgent: (agentId: string) => Promise<void>;
}) {
  const { t, locale, setLocale } = useI18n();
  // The pane mounts when it becomes the main view, so mounting is the "open": metadata is read
  // once per visit, right before the user can click download.
  const ext = useExtensionPackage(true);
  const availableAgents = useMemo(() => agents.filter((agent) => agent.available), [agents]);
  const unavailableAgents = useMemo(() => agents.filter((agent) => !agent.available), [agents]);

  const [testState, setTestState] = useState<TestState>({ status: 'idle' });
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [daemonInfo, setDaemonInfo] = useState<DaemonRuntimeInfo | null>(null);
  const [daemonError, setDaemonError] = useState('');
  const [portCopied, setPortCopied] = useState(false);

  useEffect(() => { setTestState({ status: 'idle' }); }, [agentId]);

  const loadDaemonInfo = useCallback(async () => {
    setDaemonError('');
    try {
      setDaemonInfo(await fetchDaemonInfo());
    } catch (err) {
      setDaemonInfo(null);
      setDaemonError(err instanceof Error ? err.message : t('errors.daemonInfo'));
    }
  }, [t]);

  // The port is only meaningful while this page is visible: refetch on mount so a restarted daemon
  // (or a port changed by tools-dev) is reflected without reloading the app.
  useEffect(() => { void loadDaemonInfo(); }, [loadDaemonInfo]);

  useEffect(() => {
    if (!portCopied) return;
    const timer = setTimeout(() => setPortCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [portCopied]);

  // The extension takes a port number and nothing else (the host is always 127.0.0.1).
  const port = daemonInfo?.port ?? null;

  const copyPort = async () => {
    if (port == null) return;
    try {
      await navigator.clipboard.writeText(String(port));
      setPortCopied(true);
    } catch {
      setDaemonError(t('markdown.copyFailed'));
    }
  };

  const selectedAgent = availableAgents.find((agent) => agent.id === agentId) ?? null;
  // Last known quota reading (observed from real runs — see daemon/runtimes/quota-state.ts).
  const quota = selectedAgent?.quota;
  const quotaStatusText =
    quota?.status === 'exhausted'
      ? t('settings.quotaExhausted')
      : quota?.status === 'ok'
        ? t('settings.quotaOk')
        : t('settings.quotaUnknown');
  const quotaUsageText =
    quota?.lastUsage && (quota.lastUsage.inputTokens != null || quota.lastUsage.outputTokens != null)
      ? t('settings.quotaLastUsage', {
          input: quota.lastUsage.inputTokens ?? 0,
          output: quota.lastUsage.outputTokens ?? 0,
        })
      : '';

  const connect = async (agent: AgentInfo) => {
    setConnectingId(agent.id);
    setError('');
    try {
      await onConnectAgent(agent.id);
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
      const result = await testConnection(selectedAgent.id, model.trim() || undefined);
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
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header data-remixclip-titlebar className="flex h-12 min-w-0 shrink-0 items-center gap-1.5 px-3">
        {(sidebarCollapsed || sidebarCompact) && (
          <Button
            ref={sidebarToggleRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t('sidebar.open')}
            aria-controls="chat-sidebar"
            aria-expanded={sidebarCompact ? sidebarDrawerOpen : !sidebarCollapsed}
            className="size-7 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={() => {
              if (sidebarCompact) setSidebarDrawerOpen(true);
              else setSidebarCollapsed(false);
            }}
          >
            <PanelLeftOpen className="size-4" aria-hidden="true" />
          </Button>
        )}
        <h3 className="min-w-0 flex-1 truncate px-1 text-base font-semibold text-foreground">
          {t('settings.title')}
        </h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 shrink-0 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={t('common.close')}
          onClick={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto flex w-full max-w-[620px] flex-col gap-6 px-6 pb-14 pt-1">
          <p className="text-[12.5px] leading-5 text-muted-foreground">{t('settings.description')}</p>

          {/* ── Agent (global) ─────────────────────────────────────────── */}
          <SettingsSection
            label={t('settings.agentSection')}
            action={(
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="-mr-1 text-muted-foreground hover:text-foreground"
                disabled={agentsLoading}
                onClick={() => void onRescan()}
              >
                <RefreshCw className={cn('size-3.5', agentsLoading && 'animate-spin')} aria-hidden="true" />
                {t('agent.rescan')}
              </Button>
            )}
          >
            <p className="px-4 py-2.5 text-[11.5px] leading-5 text-muted-foreground">{t('settings.agentHint')}</p>

            {agentsLoading && availableAgents.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-3 text-[12.5px] text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                {t('agent.scanning')}
              </div>
            ) : availableAgents.length === 0 ? (
              <div className="px-4 py-4 text-center">
                <p className="text-[13px] text-foreground">{t('agent.noneTitle')}</p>
                <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">{t('agent.noneDesc')}</p>
              </div>
            ) : (
              <ul className="divide-y divide-border/60" aria-label={t('agent.availableAria')}>
                {availableAgents.map((agent) => {
                  const inUse = agent.id === agentId;
                  const connecting = connectingId === agent.id;
                  return (
                    <li
                      key={agent.id}
                      className={cn(
                        'flex min-w-0 items-center gap-3 px-4 py-2.5 transition-colors',
                        inUse && 'bg-secondary/50',
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
                          {agent.quota?.status === 'exhausted' && (
                            <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-px text-[10px] text-amber-600 dark:text-amber-400">
                              {t('settings.quotaExhausted')}
                            </span>
                          )}
                        </span>
                        <span className="truncate text-[11.5px] leading-4 text-muted-foreground" title={agent.path}>
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
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedAgent?.auth?.status === 'unauthenticated' && (
              <p role="alert" className="flex items-start gap-2 px-4 py-2.5 text-[11.5px] leading-5 text-destructive">
                <TriangleAlert className="mt-1 size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  {t('agent.notLoggedInPrefix')}
                  <code className="font-mono">{selectedAgent.bin}</code>
                  {t('agent.notLoggedInSuffix')}
                </span>
              </p>
            )}

            {/*
              The model is NOT configured here: it is a per-turn choice in the composer footer,
              so this row only proves the agent works with whatever the composer sent.
            */}
            {selectedAgent && (
              <div className="flex items-start gap-3 px-4 py-2.5">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">{t('settings.quotaLabel')}</span>
                  <span
                    className={cn(
                      'text-[11.5px] leading-4',
                      quota?.status === 'exhausted' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                    )}
                  >
                    {[quotaStatusText, quota?.detail?.trim(), quotaUsageText].filter(Boolean).join(' · ')}
                  </span>
                  <span className="text-[11px] leading-4 text-muted-foreground/70">
                    {t('settings.quotaHint')}
                  </span>
                </span>
              </div>
            )}

            {selectedAgent && (
              <div className="flex items-center gap-3 px-4 py-2.5">
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="text-[13px] font-medium text-foreground">{t('settings.testRow')}</span>
                  <span
                    role={testState.status === 'done' ? (testState.result.ok ? 'status' : 'alert') : undefined}
                    className={cn(
                      'text-[11.5px] leading-4',
                      testState.status === 'done' && !testState.result.ok
                        ? 'text-destructive'
                        : 'text-muted-foreground',
                    )}
                  >
                    {testState.status === 'done' ? (
                      <>
                        {testState.result.ok ? '✓ ' : '✕ '}
                        {t(FAILURE_LABEL_KEY[testState.result.kind])}
                        {testState.result.latencyMs > 0
                          ? t('agent.testLatency', { seconds: (testState.result.latencyMs / 1000).toFixed(1) })
                          : ''}
                        {testState.result.detail ? ` · ${testState.result.detail}` : ''}
                      </>
                    ) : (
                      t('settings.testHint')
                    )}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
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
            )}

            {unavailableAgents.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-4 py-2.5 text-left text-[11.5px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
                  {t('agent.unavailableCount', { count: unavailableAgents.length })}
                  <span className="truncate text-muted-foreground/70">{t('agent.installThenRescan')}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="pb-1.5">
                    {unavailableAgents.map((agent) => (
                      <li key={agent.id} className="flex items-start gap-2 px-4 py-1.5">
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
          </SettingsSection>

          {/* ── Browser companion ─────────────────────────────────────── */}
          <SettingsSection label={t('settings.extensionSection')}>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary">
                <Download className="size-4 text-foreground" aria-hidden="true" />
              </span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="truncate text-[13px] font-medium text-foreground">{t('settings.extensionName')}</span>
                <span className="truncate text-[11.5px] leading-4 text-muted-foreground">
                  {ext.info?.available && ext.info.version
                    ? t('library.ext.meta', {
                        version: ext.info.version,
                        size: ext.info.size == null ? '—' : formatSize(ext.info.size),
                      })
                    : ext.loading
                      ? t('library.loading')
                      : t('library.ext.missing')}
                </span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={ext.loading || ext.downloading || (ext.info != null && !ext.info.available)}
                onClick={() => void ext.download()}
              >
                {ext.downloading ? (
                  <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <Download className="size-3" aria-hidden="true" />
                )}
                {ext.downloading ? t('library.ext.downloading') : t('library.ext.download')}
              </Button>
            </div>

            {/*
              The port belongs to the companion: it is the only thing the extension is configured
              with (the host is always 127.0.0.1), so it lives under this section, not as its own.
            */}
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[13px] font-medium text-foreground">{t('settings.portLabel')}</span>
                  <code className="font-mono text-[12.5px] text-muted-foreground">{daemonInfo?.port ?? '—'}</code>
                </span>
                <span className="text-[11.5px] leading-4 text-muted-foreground">{t('settings.portHint')}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                disabled={port == null}
                onClick={() => void copyPort()}
              >
                {portCopied ? (
                  <Check className="size-3" aria-hidden="true" />
                ) : (
                  <Copy className="size-3" aria-hidden="true" />
                )}
                {portCopied ? t('common.copied') : t('settings.copyPort')}
              </Button>
            </div>

            <p className="px-4 py-2.5 text-[11px] leading-4 text-muted-foreground/80">{t('library.ext.installHint')}</p>

            {(ext.error || ext.downloadedFile) && (
              <p
                role={ext.error ? 'alert' : 'status'}
                className={cn(
                  'px-4 py-2.5 text-[11.5px] leading-5',
                  ext.error ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {ext.error ?? t('library.ext.downloaded', { file: ext.downloadedFile ?? '' })}
              </p>
            )}

            {daemonError && (
              <p role="alert" className="px-4 py-2.5 text-[11.5px] leading-5 text-destructive">{daemonError}</p>
            )}
          </SettingsSection>

          {/* ── Language ──────────────────────────────────────────────── */}
          <SettingsSection label={t('settings.languageSection')}>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-[13px] font-medium text-foreground">{t('locale.label')}</span>
                <span className="text-[11.5px] leading-4 text-muted-foreground">{t('settings.languageHint')}</span>
              </span>
              <Select value={locale} onValueChange={(next) => setLocale(next as Locale)}>
                <SelectTrigger
                  size="sm"
                  aria-label={t('locale.switcherAria')}
                  className="h-7 w-[130px] shrink-0 justify-between gap-1 rounded-md border-border/70 bg-background px-2 text-[12.5px] shadow-none"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="end" className="min-w-[130px]">
                  {LOCALES.map((item) => (
                    <SelectItem key={item} value={item} className="text-[12.5px]">
                      {LOCALE_LABEL[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </SettingsSection>

          {error && (
            <p role="alert" className="rounded-md bg-secondary p-2 text-[12px] text-foreground">{error}</p>
          )}
        </div>
      </div>
    </div>
  );
}
