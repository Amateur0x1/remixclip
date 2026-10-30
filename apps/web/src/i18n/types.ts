/**
 * i18n dictionary types — the single source of truth for all UI copy.
 *
 * ## Why the canonical locale is zh-CN (the inverse of open-design)
 *
 * open-design uses en as canonical because its source language is English; RemixClip is the
 * opposite: the product copy was originally all Chinese, the primary users are Chinese, and
 * en is a later translation. Therefore:
 *
 * - `Dict` in this file is defined against the Chinese copy;
 * - `locales/zh-CN.ts` and `locales/en.ts` must both be **complete** implementations — no
 *   `...zhCN` spreading (otherwise a missing entry would still pass the type check);
 * - the runtime fallback chain is locale → zh-CN → the key itself, so a missing key renders
 *   the key and the gap is obvious at a glance;
 * - new copy is written in Chinese first, then translated to English. **Do not flip this to
 *   en-first the way od does.**
 *
 * ## Why flat dotted keys (instead of nested objects)
 *
 * A nested structure only reports "some generic object doesn't match", which hides the
 * offending string; flat keys let TS point the error at that exact line. Convention:
 * `<domain>.<semantic>`, with domains following the UI regions
 * (sidebar / chat / tool / library / agent / errors …).
 */

export type Locale = 'zh-CN' | 'en';

/** Supported locales. Adding one means also adding `locales/<tag>.ts` and `LOCALE_LABEL`. */
export const LOCALES: Locale[] = ['zh-CN', 'en'];

/** Fallback locale: the dictionary is defined against it and other locales fall back to it. */
export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** Language names are never translated — the switcher shows each one in its own language. */
export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

/**
 * The locale preference is stored under two keys:
 * - `remixclip:locale`        the current value;
 * - `remixclip:locale-source` where it came from; only `'manual'` means the user picked it.
 *
 * Why two keys: otherwise an early auto-detected value would pin the app language, and a later
 * system-language change would never be followed. Only a manual value takes precedence over
 * system detection on the next launch.
 */
export const LOCALE_STORAGE_KEY = 'remixclip:locale';
export const LOCALE_SOURCE_STORAGE_KEY = 'remixclip:locale-source';

export type LocaleSource = 'manual' | 'auto';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN' || value === 'en';
}

/**
 * The full copy table. Placeholders are written as `{name}`, and both locales must use the
 * same placeholder set (`pnpm i18n:check` verifies this entry by entry).
 */
export interface Dict {
  // ── app ────────────────────────────────────────────────────────────────
  /**
   * Brand name, identical in both locales — not translated.
   * It lives here so decisions like "the brand name" sit in one place, instead of every
   * component hard-coding its own literal.
   */
  'app.brandName': string;
  'app.metadata.title': string;
  'app.metadata.description': string;

  // ── common ─────────────────────────────────────────────────────────────
  'common.cancel': string;
  'common.close': string;
  'common.clear': string;
  'common.copied': string;
  'common.create': string;
  'common.done': string;
  'common.newChat': string;
  'common.remove': string;
  'common.retry': string;

  // ── locale switcher ────────────────────────────────────────────────────
  'locale.label': string;
  'locale.switcherAria': string;

  // ── sidebar ────────────────────────────────────────────────────────────
  'sidebar.agentMissing': string;
  /** Bottom agent pill: opens the settings drawer. */
  'sidebar.agentSettingsAria': string;
  'sidebar.close': string;
  'sidebar.closeSearch': string;
  'sidebar.collapse': string;
  'sidebar.connectAgent': string;
  'sidebar.confirmDeleteProject': string;
  'sidebar.deleteChat': string;
  'sidebar.deleteProject': string;
  'sidebar.detecting': string;
  'sidebar.drawerDescription': string;
  'sidebar.drawerTitle': string;
  'sidebar.missingSuffix': string;
  'sidebar.newProject': string;
  'sidebar.newProjectDesc': string;
  /** New chat lives inside the active project, so its aria names that project. */
  'sidebar.newChatInProject': string;
  'sidebar.open': string;
  'sidebar.projectActions': string;
  'sidebar.projectNameAria': string;
  'sidebar.projectNamePlaceholder': string;
  'sidebar.projects': string;
  'sidebar.projectsAria': string;
  'sidebar.projectsLoading': string;
  'sidebar.recentEmpty': string;
  'sidebar.regionAria': string;
  'sidebar.renameProject': string;
  'sidebar.running': string;
  'sidebar.search': string;
  'sidebar.searchAria': string;
  'sidebar.searchEmpty': string;
  'sidebar.searchFound': string;
  'sidebar.searchPlaceholder': string;
  'sidebar.searchResults': string;
  'sidebar.searchResultsAria': string;
  'sidebar.showLess': string;
  'sidebar.showMore': string;
  'sidebar.threadActions': string;
  'sidebar.untitled': string;
  'sidebar.untitledProject': string;

  // ── workspace tabs ─────────────────────────────────────────────────────
  'tabs.aria': string;
  'tabs.chat': string;
  'tabs.library': string;

  // ── workspace ──────────────────────────────────────────────────────────
  'workspace.attachmentPending': string;
  'workspace.cliDefault': string;
  'workspace.confirmDelete': string;
  'workspace.creatingRun': string;
  'workspace.newChatTitle': string;

  // ── chat ───────────────────────────────────────────────────────────────
  'chat.agentStarted': string;
  'chat.attach': string;
  'chat.attachHint': string;
  'chat.blankDesc': string;
  'chat.blankTitle': string;
  'chat.connLost': string;
  'chat.detectingButton': string;
  'chat.emptyPickAgent': string;
  'chat.emptyPickAgentDesc': string;
  /** Empty state when an agent is connected: which project (and agent/model) the new chat runs in. */
  'chat.emptyProjectLine': string;
  'chat.emptyTitle': string;
  'chat.errorPrefix': string;
  'chat.jumpToBottom': string;
  'chat.messageAria': string;
  'chat.model': string;
  'chat.modelAuto': string;
  'chat.newline': string;
  'chat.placeholderIdle': string;
  'chat.placeholderRunning': string;
  'chat.queueHint': string;
  'chat.removeAttachment': string;
  'chat.running': string;
  'chat.send': string;
  'chat.stopped': string;
  'chat.stopping': string;
  'chat.stopFailed': string;
  'chat.switchAgent': string;
  'chat.switchHint': string;
  'chat.thinking': string;

  // ── message ────────────────────────────────────────────────────────────
  'message.artifactCreated': string;
  'message.artifactUpdated': string;
  'message.artifacts': string;
  'message.closePreview': string;
  'message.copyReply': string;
  'message.htmlPreview': string;
  'message.imageLightbox': string;
  'message.imagePreview': string;
  'message.noTextOutput': string;
  'message.stoppedPrefix': string;
  'message.thinking': string;

  // ── tool tree ──────────────────────────────────────────────────────────
  'tool.arguments': string;
  'tool.called': string;
  'tool.childCount': string;
  'tool.completed': string;
  'tool.errorAria': string;
  'tool.execFailed': string;
  'tool.execResult': string;
  'tool.failed': string;
  'tool.inputAria': string;
  'tool.liveOutput': string;
  'tool.noDetails': string;
  'tool.noTextOutput': string;
  'tool.outputAria': string;
  'tool.rowAria': string;
  'tool.running': string;
  'tool.statusAria': string;
  'tool.subagentAria': string;
  'tool.subagentLabel': string;
  'tool.subagentReply': string;
  'tool.viewDetails': string;
  'tool.waiting': string;

  // ── markdown ───────────────────────────────────────────────────────────
  'markdown.code': string;
  'markdown.codeAria': string;
  'markdown.codeLangAria': string;
  'markdown.copy': string;
  'markdown.copyCode': string;
  'markdown.copyFailed': string;
  'markdown.copyFailedAria': string;
  'markdown.tableAria': string;

  // ── reconnect ──────────────────────────────────────────────────────────
  'reconnect.action': string;
  'reconnect.detail': string;
  'reconnect.failed': string;
  'reconnect.reconnecting': string;
  'reconnect.retrying': string;

  // ── ui primitives ──────────────────────────────────────────────────────
  'composer.send': string;
  'composer.stop': string;
  'dialog.close': string;
  'panel.close': string;
  'tag.remove': string;

  // ── platform names ─────────────────────────────────────────────────────
  'platform.bilibili': string;
  'platform.douyin': string;
  'platform.xhs': string;

  // ── library: list ──────────────────────────────────────────────────────
  'library.clearAll': string;
  'library.clearFilters': string;
  'library.clearedNotice': string;
  'library.confirmClear': string;
  'library.connectAria': string;
  'library.copyCaption': string;
  'library.copyFailed': string;
  'library.copyLinkAria': string;
  'library.dropHint': string;
  'library.dropTitle': string;
  'library.emptyHint': string;
  'library.emptyTitle': string;
  'library.importAction': string;
  'library.importAria': string;
  'library.importTitle': string;
  'library.addedNotice': string;
  /** Library "all platforms" filter (not a language name, but it still follows the UI locale). */
  'library.allPlatforms': string;
  /** Compact-number suffixes: ten-thousand/hundred-million units in Chinese, K/B in English. */
  'library.compactHundredMillion': string;
  'library.compactTenThousand': string;
  'library.importedNotice': string;
  'library.linkCopied': string;
  'library.loadMore': string;
  'library.loadingMore': string;
  'library.moreAria': string;
  'library.onboardingDesc': string;
  'library.onboardingDragHint': string;
  'library.onboardingImport': string;
  'library.onboardingTitle': string;
  'library.pickJson': string;
  'library.readFailed': string;
  'library.removedNotice': string;
  'library.searchAria': string;
  'library.searchPlaceholder': string;
  'library.sortAria': string;
  'library.sortImported': string;
  'library.sortLikes': string;
  'library.sortPublished': string;
  'library.step1Desc': string;
  'library.step1Title': string;
  'library.step2Desc': string;
  'library.step2Title': string;
  'library.step3Desc': string;
  'library.step3Title': string;
  'library.updatedNotice': string;

  // ── library: card ──────────────────────────────────────────────────────
  'library.card': string;
  'library.commentsCount': string;
  'library.justImported': string;
  'library.openPost': string;
  'library.unknownAuthor': string;
  'library.untitled': string;
  'library.video': string;
  'library.viewItemAria': string;

  // ── library: detail ────────────────────────────────────────────────────
  'library.aligned': string;
  'library.anonymous': string;
  'library.caption': string;
  'library.cardNoComments': string;
  'library.cardOnly': string;
  'library.capturedComments': string;
  'library.closeDetail': string;
  'library.commentsUnit': string;
  'library.compareFailed': string;
  'library.compareHint': string;
  'library.compareMatch': string;
  'library.compareMinor': string;
  'library.compareMismatch': string;
  'library.compareRetryHint': string;
  'library.compareRunning': string;
  'library.compareStructure': string;
  'library.comparingFrames': string;
  'library.confirmRemove': string;
  'library.detailDesc': string;
  'library.detailTitle': string;
  'library.download': string;
  'library.downloadFailed': string;
  'library.downloadFirstHint': string;
  'library.downloading': string;
  'library.exactDiff': string;
  'library.frameDiff': string;
  'library.frameRender': string;
  'library.imageLoadFailed': string;
  'library.keepRecent': string;
  'library.loading': string;
  'library.mediaAlt': string;
  'library.metricCollects': string;
  'library.metricComments': string;
  'library.metricLikes': string;
  'library.metricShares': string;
  'library.needRenderFirst': string;
  'library.needShotsFirst': string;
  'library.noComments': string;
  'library.noComparison': string;
  'library.noFrame': string;
  'library.noFrames': string;
  'library.noPreviewMedia': string;
  'library.noShots': string;
  'library.notAnalyzed': string;
  'library.notCompared': string;
  'library.notDownloaded': string;
  'library.notUploaded': string;
  'library.perceptualCaption': string;
  'library.perceptualDiff': string;
  'library.pipeline': string;
  'library.pipelineSteps': string;
  'library.queued': string;
  'library.downloadQueued': string;
  'library.reanalyze': string;
  'library.recentComparisons': string;
  'library.removeFromLibrary': string;
  'library.renderReady': string;
  'library.rowCompare': string;
  'library.rowRender': string;
  'library.rowShots': string;
  'library.rowSource': string;
  'library.sampleFrameAria': string;
  'library.savedLocally': string;
  'library.selectRender': string;
  'library.shotAlt': string;
  'library.shotCountSummary': string;
  'library.shotCounter': string;
  'library.shotMatch': string;
  'library.shotMinor': string;
  'library.shotMismatch': string;
  'library.shotScoreAria': string;
  'library.shotWord': string;
  'library.shotsFailed': string;
  'library.shotsLink': string;
  'library.sourceFrom': string;
  'library.sourceReady': string;
  'library.splitFrames': string;
  'library.splitFramesShort': string;
  'library.startCompare': string;
  'library.startShots': string;
  'library.startShotsHint': string;
  'library.switchShotHint': string;
  'library.tabCompare': string;
  'library.tabPreview': string;
  'library.tabShots': string;
  'library.upload': string;
  'library.uploadAnother': string;
  'library.viewImageAria': string;

  // ── library: pairing dialog ────────────────────────────────────────────
  'library.connect.autoAction': string;
  'library.connect.autoDesc': string;
  'library.connect.autoDone': string;
  'library.connect.autoExpiredHint': string;
  'library.connect.autoOpen': string;
  'library.connect.autoOpenHint': string;
  'library.connect.autoReopen': string;
  'library.connect.autoTitle': string;
  'library.connect.code': string;
  'library.connect.copyCode': string;
  'library.connect.copyEndpoint': string;
  'library.connect.copyFailed': string;
  'library.connect.deviceCount': string;
  'library.connect.devices': string;
  'library.connect.desc': string;
  'library.connect.endpoint': string;
  'library.connect.endpointHint': string;
  'library.connect.expired': string;
  'library.connect.expiredHint': string;
  'library.connect.expiresIn': string;
  'library.connect.fetchFailed': string;
  'library.connect.finish': string;
  'library.connect.loopback': string;
  'library.connect.manualToggle': string;
  'library.connect.noDevices': string;
  'library.connect.reading': string;
  'library.connect.regenerate': string;
  'library.connect.revoke': string;
  'library.connect.revokeFailed': string;
  'library.connect.step1Middle': string;
  'library.connect.step1Prefix': string;
  'library.connect.step1Suffix': string;
  'library.connect.step2': string;
  'library.connect.step3': string;
  'library.connect.title': string;

  // ── library: import dialog ─────────────────────────────────────────────
  'library.import.action': string;
  'library.import.failed': string;
  'library.import.importing': string;
  'library.import.noFields': string;
  'library.import.notObject': string;
  'library.import.parseFailed': string;
  'library.import.parsing': string;
  'library.import.platformHint': string;
  'library.import.platformLabel': string;
  'library.import.statCards': string;
  'library.import.statComments': string;
  'library.import.statNotes': string;
  'library.import.statUsers': string;

  // ── agent detect dialog ────────────────────────────────────────────────
  'agent.added': string;
  'agent.availableAria': string;
  'agent.bundled': string;
  'agent.capabilities': string;
  'agent.capabilitiesAria': string;
  'agent.chooseAgent': string;
  'agent.cliDefault': string;
  'agent.cliDefaultEmpty': string;
  'agent.customModel': string;
  'agent.customModelAria': string;
  'agent.customModelPlaceholder': string;
  'agent.desc': string;
  /** "Detected <b>{count}</b> available agents" is split into two parts so the number keeps its font-medium styling. */
  'agent.detectedPrefix': string;
  'agent.detectedSuffix': string;
  'agent.detectTitle': string;
  'agent.firstRunTitle': string;
  'agent.installDocs': string;
  'agent.installThenRescan': string;
  'agent.installed': string;
  'agent.inUse': string;
  'agent.modelLabel': string;
  'agent.noneDesc': string;
  'agent.noneTitle': string;
  'agent.notInPath': string;
  'agent.notLoggedInPrefix': string;
  'agent.notLoggedInSuffix': string;
  'agent.requestDaemonFailed': string;
  'agent.rescan': string;
  'agent.saveFailed': string;
  'agent.saving': string;
  'agent.scanNote': string;
  'agent.scanning': string;
  'agent.testAuth': string;
  'agent.testBinary': string;
  'agent.testConnection': string;
  'agent.testLatency': string;
  'agent.testModel': string;
  'agent.testNetwork': string;
  'agent.testOk': string;
  'agent.testTimeout': string;
  'agent.testUnknown': string;
  'agent.testing': string;
  'agent.unavailableCount': string;
  'agent.unavailableSuffix': string;
  'agent.useAgent': string;

  // ── settings drawer ────────────────────────────────────────────────────
  'settings.agentHint': string;
  'settings.agentSection': string;
  'settings.connect': string;
  'settings.connected': string;
  'settings.description': string;
  'settings.modelFor': string;
  'settings.modelPlaceholder': string;
  'settings.needsLogin': string;
  'settings.title': string;

  // ── errors (failures produced by the frontend; errors returned by the daemon pass through as-is and are not listed here) ──
  'errors.agentConnect': string;
  'errors.agentsHttp': string;
  'errors.analyze': string;
  'errors.analyzeLabel': string;
  'errors.appConfigGetHttp': string;
  'errors.appConfigPutHttp': string;
  'errors.attachmentTranscript': string;
  'errors.comparisonLabel': string;
  'errors.comparisonRead': string;
  'errors.comparisonsLabel': string;
  'errors.comparisonsRead': string;
  'errors.compareLabel': string;
  'errors.compareStart': string;
  'errors.contractMismatch': string;
  'errors.contractMismatchField': string;
  'errors.createConversation': string;
  'errors.createProject': string;
  'errors.deleteProject': string;
  'errors.noProject': string;
  'errors.updateProject': string;
  'errors.createRun': string;
  'errors.createRunHttp': string;
  'errors.daemonHttp': string;
  'errors.deleteConversation': string;
  'errors.deleteConversationHttp': string;
  'errors.deviceRevoke': string;
  'errors.deviceRevokeLabel': string;
  'errors.httpSuffix': string;
  'errors.libraryClear': string;
  'errors.libraryClearLabel': string;
  'errors.libraryDelete': string;
  'errors.libraryDetailLabel': string;
  'errors.libraryDetailRead': string;
  'errors.libraryImport': string;
  'errors.libraryImportLabel': string;
  'errors.libraryListLabel': string;
  'errors.libraryRead': string;
  'errors.loadConversation': string;
  'errors.loadWorkspace': string;
  'errors.mediaDelete': string;
  'errors.mediaDownload': string;
  'errors.mediaDownloadLabel': string;
  'errors.mediaListLabel': string;
  'errors.mediaListRead': string;
  'errors.notJson': string;
  'errors.pairingFetch': string;
  'errors.pairingLabel': string;
  'errors.readFile': string;
  'errors.renderLabel': string;
  'errors.renderUpload': string;
  'errors.shotsLabel': string;
  'errors.shotsRead': string;
  'errors.sseHttp': string;
  'errors.sseInterrupted': string;
  'errors.unknown': string;
  'errors.uploadAttachmentHttp': string;
  'errors.uploadFailed': string;
}

export type DictKey = keyof Dict;
