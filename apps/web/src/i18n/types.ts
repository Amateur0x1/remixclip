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
  'common.remove': string;
  'common.retry': string;

  // ── locale switcher ────────────────────────────────────────────────────
  'locale.label': string;
  'locale.switcherAria': string;

  // ── sidebar ────────────────────────────────────────────────────────────
  'sidebar.agentMissing': string;
  'sidebar.close': string;
  'sidebar.closeSearch': string;
  'sidebar.collapse': string;
  'sidebar.connectAgent': string;
  'sidebar.confirmDeleteProject': string;
  'sidebar.deleteProject': string;
  'sidebar.detecting': string;
  'sidebar.drawerDescription': string;
  'sidebar.drawerTitle': string;
  'sidebar.missingSuffix': string;
  'sidebar.newProject': string;
  'sidebar.newProjectDesc': string;
  'sidebar.createNeedsMaterial': string;
  /** New chat lives inside the active project, so its aria names that project. */
  /** The dialog a project's hover "+" opens. */
  'sidebar.open': string;
  'sidebar.projectActions': string;
  'sidebar.projectNameAria': string;
  'sidebar.projectNamePlaceholder': string;
  'sidebar.projects': string;
  'sidebar.projectsAria': string;
  'sidebar.projectsLoading': string;
  'sidebar.regionAria': string;
  'sidebar.renameProject': string;
  'sidebar.running': string;
  'sidebar.search': string;
  'sidebar.searchAria': string;
  'sidebar.searchEmpty': string;
  'sidebar.searchPlaceholder': string;
  'sidebar.settingsAria': string;
  'sidebar.untitledProject': string;

  // ── workspace tabs ─────────────────────────────────────────────────────
  'tabs.aria': string;
  'tabs.chat': string;
  'tabs.library': string;
  'tabs.cuts': string;

  // ── finished cuts (成片库) ────────────────────────────────────────────────
  'cuts.emptyTitle': string;
  'cuts.emptyDesc': string;
  'cuts.openProject': string;
  'cuts.preview': string;
  'cuts.refresh': string;
  'cuts.updatedAt': string;

  // ── workspace ──────────────────────────────────────────────────────────
  'workspace.attachmentPending': string;
  'workspace.cliDefault': string;
  'workspace.creatingRun': string;
  'workspace.defaultProject': string;
  'workspace.newChatTitle': string;

  // ── home (nothing opened yet) ──────────────────────────────────────────
  /** The hero above the composer: the only prompt the app shows before any chat exists. */
  'home.title': string;
  'home.subtitle': string;
  'home.placeholder': string;
  /** The folder the agent writes into; shown under the hero composer with the project name. */
  'home.workingDir': string;
  'home.workingDirHint': string;
  /** Starter lanes: each drops a brief into the composer so the first message isn't a blank page. */
  'home.chipPrototype': string;
  'home.chipMotion': string;
  'home.chipDeck': string;
  'home.chipMore': string;
  'home.chipDocument': string;
  'home.chipImage': string;
  'home.chipVideo': string;
  'home.promptPrototype': string;
  'home.promptMotion': string;
  'home.promptDeck': string;
  'home.promptDocument': string;
  'home.promptImage': string;
  'home.promptVideo': string;
  'home.pickMaterials': string;
  'home.pickMaterialsDesc': string;

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
  'chat.errorPrefix': string;
  'chat.jumpToBottom': string;
  'chat.messageAria': string;
  'chat.model': string;
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
  'chat.loadingHistory': string;
  'chat.thinking': string;

  // ── artifacts panel / viewer ───────────────────────────────────────────
  'artifacts.toggle': string;
  'artifacts.title': string;
  'artifacts.close': string;
  'artifacts.refresh': string;
  'artifacts.empty': string;
  'artifacts.loading': string;
  'artifacts.loadFailed': string;
  'artifacts.retry': string;
  'artifacts.folderEmpty': string;
  'artifacts.download': string;
  'artifacts.previewUnavailable': string;
  'artifacts.tooLarge': string;
  'artifacts.loadTextFailed': string;
  'artifacts.truncated': string;

  // ── message ────────────────────────────────────────────────────────────
  'message.artifactCreated': string;
  'message.artifactUpdated': string;
  'message.artifacts': string;
  'message.artifactsSize': string;
  'message.closePreview': string;
  'message.copyReply': string;
  'message.htmlPreview': string;
  'message.imageLightbox': string;
  'message.imagePreview': string;
  'message.noTextOutput': string;
  'message.stoppedPrefix': string;
  'message.thinking': string;
  'message.workedFor': string;
  'message.workedForUnknown': string;

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
  'tool.runAria': string;
  'tool.runCommands': string;
  'tool.runDelete': string;
  'tool.runEdit': string;
  'tool.runFailed': string;
  'tool.runImage': string;
  'tool.runRead': string;
  'tool.runSearch': string;
  'tool.runWrite': string;
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
  'library.copyCaption': string;
  'library.copyFailed': string;
  'library.copyLinkAria': string;
  'library.emptyHint': string;
  'library.emptyTitle': string;
  'library.addedNotice': string;
  /** Library "all platforms" filter (not a language name, but it still follows the UI locale). */
  'library.allPlatforms': string;
  /** Compact-number suffixes: ten-thousand/hundred-million units in Chinese, K/B in English. */
  'library.importedNotice': string;
  'library.linkCopied': string;
  'library.loadMore': string;
  'library.loadingMore': string;
  'library.moreAria': string;
  'library.onboardingDesc': string;
  'library.onboardingTitle': string;
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
  'library.replicateWithAi': string;
  /** Short label for the cover button; the full sentence lives in `replicateWithAi`. */
  'library.replicateAction': string;
  'library.unknownAuthor': string;
  'library.untitled': string;
  'library.video': string;
  'library.viewDetailAction': string;
  'library.viewItemAria': string;

  // ── library: agent handoff ─────────────────────────────────────────────
  /** First message of the fresh conversation opened by the card's "replicate with AI" action. */
  'library.replicatePrompt': string;
  /** Same brief, but the source clip has been copied into the project and is named by relative path. */
  'library.replicatePromptLocal': string;
  'library.replicateDialogTitle': string;
  'library.replicateDialogDesc': string;
  /**
   * Optional brief typed in the confirm dialog; empty means "recreate the whole clip". It travels
   * as `ChatRunCreateRequest.guidance`, so it is injected into the prompt and never becomes part
   * of the message the transcript shows.
   */
  'library.replicateGuidanceLabel': string;
  'library.replicateGuidancePlaceholder': string;
  'library.replicateGuidanceHint': string;
  'library.replicateCheckingSource': string;
  /** Source clip is not on disk: the dialog downloads it before the run can start. */
  'library.replicateSourcePending': string;
  'library.replicateSourceFailed': string;
  'library.replicateDownloadNow': string;
  'library.replicateDownloading': string;
  'library.replicateStart': string;
  /** Multi-item brief: {count} selected clips, {files} = one `- reference/<name>` line each. */
  'library.replicateMultiPrompt': string;
  'library.pickTitle': string;
  'library.pickDesc': string;
  'library.pickSearch': string;
  'library.pickEmpty': string;
  'library.pickConfirm': string;
  'library.pickPreparing': string;
  'library.pickDownloadFailed': string;

  // ── downloads centre (header popover) ──────────────────────────────────
  'downloads.title': string;
  'downloads.aria': string;
  'downloads.ariaActive': string;
  'downloads.activeCount': string;
  'downloads.empty': string;
  'downloads.done': string;
  'downloads.failed': string;

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
  'library.previewExpiredDesc': string;
  'library.previewExpiredTitle': string;
  'library.previewFailedDesc': string;
  'library.previewFailedTitle': string;
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

  // ── library: companion download menu ───────────────────────────────────
  'library.ext.aria': string;
  'library.ext.cta': string;
  'library.ext.download': string;
  'library.ext.downloaded': string;
  'library.ext.downloadFailed': string;
  'library.ext.downloading': string;
  'library.ext.installHint': string;
  'library.ext.meta': string;
  'library.ext.missing': string;

  // ── agent detect dialog ────────────────────────────────────────────────
  'agent.added': string;
  'agent.availableAria': string;
  'agent.bundled': string;
  'agent.capabilities': string;
  'agent.capabilitiesAria': string;
  'agent.chooseAgent': string;
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
  'settings.copyPort': string;
  'settings.description': string;
  'settings.extensionName': string;
  'settings.extensionSection': string;
  'settings.languageHint': string;
  'settings.languageSection': string;
  'settings.needsLogin': string;
  'settings.portHint': string;
  'settings.portLabel': string;
  'settings.testHint': string;
  'settings.testRow': string;
  'settings.title': string;

  // ── errors (failures produced by the frontend; errors returned by the daemon pass through as-is and are not listed here) ──
  'errors.agentConnect': string;
  'errors.agentsHttp': string;
  'errors.analyze': string;
  'errors.analyzeLabel': string;
  'errors.appConfigGetHttp': string;
  'errors.appConfigPutHttp': string;
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
  'errors.pickMaterialsFirst': string;
  'errors.deleteProject': string;
  'errors.updateProject': string;
  'errors.createRun': string;
  'errors.createRunHttp': string;
  'errors.daemonHttp': string;
  'errors.daemonInfo': string;
  'errors.daemonInfoHttp': string;
  'errors.extensionDownloadHttp': string;
  'errors.extensionInfoHttp': string;
  'errors.backendUnavailable': string;
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
  'errors.cutsRead': string;
  'errors.loadConversation': string;
  'errors.loadWorkspace': string;
  'errors.mediaDelete': string;
  'errors.mediaDownload': string;
  'errors.mediaDownloadLabel': string;
  'errors.mediaListLabel': string;
  'errors.mediaListRead': string;
  'errors.notJson': string;
  'errors.connectionFetch': string;
  'errors.connectionLabel': string;
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
