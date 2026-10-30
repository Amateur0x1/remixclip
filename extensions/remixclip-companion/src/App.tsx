// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  loadData,
  type SnifferData,
  type NoteEntry,
  type NoteCard,
} from "./store/sniffer-store";
import type { PlatformKey } from "./types/common";
import {
  DEFAULT_REMIXCLIP_ENDPOINT,
  clearRemixclipConfig,
  loadRemixclipConfig,
  pairRemixclip,
  pairRemixclipAuto,
  pingRemixclip,
  saveRemixclipConfig,
  sendToRemixclip,
  type RemixclipConfig,
  type RemixclipExportPayload,
  type RemixclipPairResult,
} from "./lib/remixclip";

// ── Platform definitions ──

interface PlatformDef {
  key: PlatformKey;
  label: string;
  /** emoji or image path (leading / or . is treated as an image) */
  icon: string;
  color: string;
  enabled: boolean;
}

const PLATFORMS: PlatformDef[] = [
  { key: "xhs", label: "小红书", icon: "/platform-xhs.png", color: "#ff6b6b", enabled: true },
  { key: "bilibili", label: "B站", icon: "📺", color: "#00a1d6", enabled: true },
  { key: "douyin", label: "抖音", icon: "🎵", color: "#111", enabled: true },
];

/** Determine whether icon is an image path or an emoji */
function isImageIcon(icon: string): boolean {
  return icon.startsWith("/") || icon.startsWith(".");
}

type TabKey = "explore" | "user";

function App() {
  const [platform, setPlatform] = useState<PlatformKey>("xhs");
  const [data, setData] = useState<SnifferData | null>(null);
  const [tab, setTab] = useState<TabKey>("explore");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** user_id of the selected creator in the creator tab */
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  /** Creator currently expanded in the user tab */
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  // ── RemixClip binding ──
  const [bridge, setBridge] = useState<RemixclipConfig>({ endpoint: DEFAULT_REMIXCLIP_ENDPOINT, token: "" });
  const [endpointDraft, setEndpointDraft] = useState(DEFAULT_REMIXCLIP_ENDPOINT);
  const [pairCode, setPairCode] = useState("");
  const [bridgeOpen, setBridgeOpen] = useState(false);
  const [bridgeOnline, setBridgeOnline] = useState<boolean | null>(null);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeError, setBridgeError] = useState("");
  const [manualPairOpen, setManualPairOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");

  /** Shared tail of both pairing paths: remember the token, flip the UI to "connected". */
  const applyPair = useCallback(async (result: RemixclipPairResult, fallbackEndpoint: string) => {
    const next: RemixclipConfig = {
      endpoint: result.endpoint || fallbackEndpoint,
      token: result.token,
      deviceName: result.device.name,
      pairedAt: Date.now(),
    };
    await saveRemixclipConfig(next);
    setBridge(next);
    setEndpointDraft(next.endpoint);
    setPairCode("");
    setBridgeOnline(true);
    return next;
  }, []);

  const activePlatform = PLATFORMS.find((p) => p.key === platform)!;

  const refresh = useCallback(async () => {
    try {
      const d = await loadData(platform);
      setData(d);
    } catch (err) {
      console.error("加载数据失败:", err);
    }
  }, [platform]);

  useEffect(() => {
    void loadRemixclipConfig().then(async (config) => {
      setBridge(config);
      setEndpointDraft(config.endpoint);
      if (config.token) return;
      // Opening the panel is enough after the user clicks 「开启自动连接」 in the app: try silently.
      if (!(await pingRemixclip(config.endpoint))) return;
      try {
        await applyPair(await pairRemixclipAuto(config.endpoint), config.endpoint);
        setSendStatus("已连接 RemixClip，之后的导出会直接进入素材库");
      } catch {
        // No trust window open yet — the connect panel explains how to open one.
      }
    });
  }, [applyPair]);

  useEffect(() => {
    if (!sendStatus) return;
    const timer = setTimeout(() => setSendStatus(""), 8000);
    return () => clearTimeout(timer);
  }, [sendStatus]);

  useEffect(() => {
    if (!bridgeOpen || bridge.token) return;
    let cancelled = false;
    setBridgeOnline(null);
    void (async () => {
      const online = await pingRemixclip(endpointDraft);
      if (cancelled) return;
      setBridgeOnline(online);
      if (!online) return;
      // The app may already be in its 2-minute trust window: pair without asking for a code.
      try {
        await applyPair(await pairRemixclipAuto(endpointDraft), endpointDraft);
        if (cancelled) return;
        setBridgeError("");
        setSendStatus("已连接 RemixClip，之后的导出会直接进入素材库");
      } catch {
        // Window closed: keep the panel open so the user can start it in the app.
      }
    })();
    return () => { cancelled = true; };
  }, [bridgeOpen, bridge.token, endpointDraft, applyPair]);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: "sidepanel" });
    refresh();
    const listener = (msg: { type?: string; platform?: PlatformKey }) => {
      if (msg.type === "SNIFFER_UPDATED") {
        // Only refresh when the current platform's data updates, or always when no
        // platform is specified
        if (!msg.platform || msg.platform === platform) refresh();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => {
      port.disconnect();
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [refresh, platform]);

  // ── Notes grouped by tab ──

  const exploreNotes = useMemo(() => {
    if (!data) return [];
    return Object.values(data.notes)
      .filter((n) => n.source === "explore" || n.source === "note_detail")
      .sort((a, b) => (b.time || 0) - (a.time || 0));
  }, [data]);

  const userNotes = useMemo(() => {
    if (!data) return [];
    return Object.values(data.notes)
      .filter((n) => n.source === "user")
      .sort((a, b) => (b.time || 0) - (a.time || 0));
  }, [data]);

  // Card data of user pages (user_posted API)
  const userCards = useMemo(() => {
    if (!data) return [];
    return data.noteCards.filter((c) => c.source_user_id);
  }, [data]);

  // Creator grouping
  const userGroups = useMemo(() => {
    if (!data) return [];

    // Also include creators that have data but no profile
    const allUserIds = new Set<string>();
    userNotes.forEach((n) => n.source_user_id && allUserIds.add(n.source_user_id));
    userCards.forEach((c) => c.source_user_id && allUserIds.add(c.source_user_id));

    return Array.from(allUserIds).map((uid) => {
      const profile = data.userProfiles[uid];
      const notes = userNotes.filter((n) => n.source_user_id === uid);
      const cards = userCards.filter((c) => c.source_user_id === uid);
      return {
        user_id: uid,
        user_name: profile?.user_name || notes[0]?.author || cards[0]?.author || uid.slice(0, 8),
        notes,
        cards,
        total: notes.length + cards.length,
      };
    }).sort((a, b) => b.total - a.total);
  }, [data, userNotes, userCards]);

  // ── Selection logic ──
  // explore tab: selects note_id
  // user tab creator list: selects creator user_id
  // user tab after expanding: selects note_id

  /** Whether currently in creator selection mode (user tab not expanded) */
  const isUserListMode = tab === "user" && !expandedUser;

  const currentNoteIds = useMemo(() => {
    if (tab === "explore") return exploreNotes.map((n) => n.note_id);
    if (tab === "user" && expandedUser) {
      const group = userGroups.find((g) => g.user_id === expandedUser);
      return group ? group.notes.map((n) => n.note_id) : [];
    }
    return [];
  }, [tab, exploreNotes, userGroups, expandedUser]);

  const currentUserIds = useMemo(() => {
    return userGroups.map((g) => g.user_id);
  }, [userGroups]);

  // Only count comments of notes in the current view, so the number doesn't mismatch when
  // switching tabs
  const commentCount = useMemo(() => {
    if (!data) return 0;
    return currentNoteIds.reduce((acc, id) => acc + (data.comments[id]?.length ?? 0), 0);
  }, [data, currentNoteIds]);

  const allSelected = isUserListMode
    ? currentUserIds.length > 0 && currentUserIds.every((id) => selectedUsers.has(id))
    : currentNoteIds.length > 0 && currentNoteIds.every((id) => selected.has(id));

  const selectionCount = isUserListMode ? selectedUsers.size : selected.size;

  const toggleAll = () => {
    if (isUserListMode) {
      const next = new Set(selectedUsers);
      if (allSelected) {
        currentUserIds.forEach((id) => next.delete(id));
      } else {
        currentUserIds.forEach((id) => next.add(id));
      }
      setSelectedUsers(next);
    } else {
      const next = new Set(selected);
      if (allSelected) {
        currentNoteIds.forEach((id) => next.delete(id));
      } else {
        currentNoteIds.forEach((id) => next.add(id));
      }
      setSelected(next);
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleUser = (userId: string) => {
    const next = new Set(selectedUsers);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setSelectedUsers(next);
  };

  // Assemble the export content (JSON download and send-to-RemixClip share the same data).
  const buildExportPayload = useCallback((): { payload: RemixclipExportPayload; filename: string } | null => {
    if (!data) return null;
    const exportedAt = new Date().toISOString();
    const date = exportedAt.slice(0, 10);

    // Creator list mode: export by creator
    if (isUserListMode && selectedUsers.size > 0) {
      const exportUsers = userGroups
        .filter((g) => selectedUsers.has(g.user_id))
        .map((g) => {
          const comments: Record<string, unknown> = {};
          for (const note of g.notes) {
            if (data.comments[note.note_id]) {
              comments[note.note_id] = data.comments[note.note_id];
            }
          }
          return {
            user_id: g.user_id,
            user_name: g.user_name,
            notes: g.notes,
            cards: g.cards,
            comments,
          };
        });

      return {
        payload: {
          platform,
          users: exportUsers,
          exported_count: exportUsers.length,
          exported_at: exportedAt,
        },
        filename: `${platform}-users-${date}.json`,
      };
    }

    // Note mode
    if (selected.size === 0) return null;

    const exportNotes: NoteEntry[] = [];
    const exportComments: Record<string, unknown> = {};

    for (const id of selected) {
      const note = data.notes[id];
      if (note) exportNotes.push(note);
      if (data.comments[id]) exportComments[id] = data.comments[id];
    }

    return {
      payload: {
        platform,
        notes: exportNotes,
        comments: exportComments,
        exported_count: exportNotes.length,
        exported_at: exportedAt,
      },
      filename: `${platform}-${tab}-${date}.json`,
    };
  }, [data, selected, selectedUsers, isUserListMode, userGroups, tab, platform]);

  // Main button: when paired, push straight to the library; otherwise download and lead
  // the user to pairing.
  const handleExport = useCallback(async () => {
    const built = buildExportPayload();
    if (!built) return;

    if (!bridge.token) {
      downloadJson(built.payload, built.filename);
      setBridgeError("");
      setBridgeOpen(true);
      setSendStatus("已下载 JSON。连接 RemixClip 后，导出会直接进入素材库。");
      return;
    }

    setSending(true);
    setSendStatus("");
    try {
      const result = await sendToRemixclip(bridge, built.payload);
      setSendStatus(`已发送到 RemixClip：${result.itemCount} 条（新增 ${result.created}，更新 ${result.updated}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "发送失败";
      setSendStatus(message);
      if (message.includes("配对") || message.includes("token") || message.includes("未连接")) {
        setBridgeOpen(true);
        setBridgeError(message);
      }
    } finally {
      setSending(false);
    }
  }, [buildExportPayload, bridge]);

  const handleDownload = useCallback(() => {
    const built = buildExportPayload();
    if (!built) return;
    downloadJson(built.payload, built.filename);
    setSendStatus("已下载 JSON 文件");
  }, [buildExportPayload]);

  const handlePair = useCallback(async () => {
    if (!pairCode.trim()) {
      setBridgeError("请先填写配对码");
      return;
    }
    setBridgeBusy(true);
    setBridgeError("");
    try {
      await applyPair(await pairRemixclip(endpointDraft, pairCode), endpointDraft);
      setSendStatus("已连接 RemixClip，之后的导出会直接进入素材库");
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : "配对失败");
    } finally {
      setBridgeBusy(false);
    }
  }, [endpointDraft, pairCode, applyPair]);

  /** Fast path: no code, works while the app's auto-pair window is open. */
  const handleAutoPair = useCallback(async () => {
    setBridgeBusy(true);
    setBridgeError("");
    try {
      await applyPair(await pairRemixclipAuto(endpointDraft), endpointDraft);
      setSendStatus("已连接 RemixClip，之后的导出会直接进入素材库");
    } catch (err) {
      setBridgeError(err instanceof Error ? err.message : "连接失败");
    } finally {
      setBridgeBusy(false);
    }
  }, [endpointDraft, applyPair]);

  const handleDisconnect = useCallback(async () => {
    const next = await clearRemixclipConfig();
    setBridge(next);
    setBridgeOnline(null);
    setSendStatus("已断开 RemixClip");
  }, []);

  function downloadJson(obj: unknown, filename: string) {
    const json = JSON.stringify(obj, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  const handleClear = useCallback(async () => {
    if (!confirm(`确定清空 ${activePlatform.label} 的所有采集数据？`)) return;
    // Clearing must go through the service worker: it holds the in-process cache, so
    // touching storage directly would leave stale data in the cache
    await chrome.runtime.sendMessage({ type: "SNIFFER_CLEAR", platform });
    setSelected(new Set());
    setSelectedUsers(new Set());
    setExpandedUser(null);
    await refresh();
  }, [activePlatform.label, platform, refresh]);

  return (
    <div style={S.root}>
      {/* ── Left platform sidebar ── */}
      <div style={S.sidebar}>
        <div style={S.sidebarTop}>
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              title={p.enabled ? p.label : `${p.label}（即将支持）`}
              style={{
                ...S.platformBtn,
                ...(platform === p.key ? {
                  backgroundColor: p.color + "18",
                  borderColor: p.color,
                } : {}),
                ...(p.enabled ? {} : S.platformBtnDisabled),
              }}
              onClick={() => {
                if (!p.enabled || p.key === platform) return;
                setPlatform(p.key);
                setSelected(new Set());
                setSelectedUsers(new Set());
                setExpandedUser(null);
                setTab("explore");
              }}
              disabled={!p.enabled}
            >
              {isImageIcon(p.icon)
                ? <img src={p.icon} alt={p.label} style={S.platformIconImg} />
                : <span style={S.platformIcon}>{p.icon}</span>
              }
              <span style={{
                ...S.platformLabel,
                color: platform === p.key ? p.color : (p.enabled ? "#666" : "#ccc"),
                fontWeight: platform === p.key ? 700 : 400,
              }}>
                {p.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* ── Right main content ── */}
      <div style={S.main}>
        {/* Header */}
        <div style={{ ...S.header, borderBottomColor: activePlatform.color + "40" }}>
          <div style={S.headerLeft}>
            {isImageIcon(activePlatform.icon)
              ? <img src={activePlatform.icon} alt={activePlatform.label} style={S.headerIconImg} />
              : <span style={S.headerIcon}>{activePlatform.icon}</span>
            }
            <span style={S.headerTitle}>{activePlatform.label}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              style={S.bridgeButton}
              title={bridge.token ? `已连接 ${bridge.endpoint}` : "连接 RemixClip 素材库"}
              onClick={() => setBridgeOpen(true)}
            >
              <span style={{ ...S.dot, backgroundColor: bridge.token ? "#22c55e" : "#c4c4c4" }} />
              RemixClip
            </button>
            <span style={S.headerBadge}>被动采集</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={S.tabBar}>
          {([
            ["explore", `发现 (${exploreNotes.length})`],
            ["user", `博主 (${userGroups.length})`],
          ] as [TabKey, string][]).map(([key, label]) => (
            <button
              key={key}
              style={{
                ...(tab === key ? S.tabActive : S.tab),
                ...(tab === key ? { borderBottomColor: activePlatform.color, color: activePlatform.color } : {}),
              }}
              onClick={() => { setTab(key); setExpandedUser(null); }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Toolbar */}
        {(isUserListMode ? currentUserIds.length > 0 : currentNoteIds.length > 0) && (
          <div style={S.toolbar}>
            <label style={S.checkboxLabel}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={S.checkbox} />
              全选
            </label>
            <span style={{ ...S.selectedCount, color: activePlatform.color }}>
              已选 {selectionCount} {isUserListMode ? "位博主" : "篇"}
              {!isUserListMode && commentCount > 0 && ` · 💬 ${commentCount} 条评论`}
            </span>
          </div>
        )}

        {/* Content area */}
        <div style={S.listContainer}>
          {tab === "explore" && (
            exploreNotes.length === 0 ? (
              <EmptyState text={`浏览${activePlatform.label}时自动采集`} />
            ) : (
              exploreNotes.map((note) => (
                <NoteItem
                  key={note.note_id}
                  note={note}
                  checked={selected.has(note.note_id)}
                  commentCount={data?.comments[note.note_id]?.length || 0}
                  onToggle={() => toggleOne(note.note_id)}
                  accentColor={activePlatform.color}
                />
              ))
            )
          )}

          {tab === "user" && (
            userGroups.length === 0 ? (
              <EmptyState text="浏览博主主页时自动采集" />
            ) : expandedUser ? (
              // Note list of an expanded creator
              <>
                <button
                  style={S.backBtn}
                  onClick={() => setExpandedUser(null)}
                >
                  ← 返回博主列表
                </button>
                {(() => {
                  const group = userGroups.find((g) => g.user_id === expandedUser);
                  if (!group) return null;
                  return group.notes.length > 0
                    ? group.notes.map((note) => (
                        <NoteItem
                          key={note.note_id}
                          note={note}
                          checked={selected.has(note.note_id)}
                          commentCount={data?.comments[note.note_id]?.length || 0}
                          onToggle={() => toggleOne(note.note_id)}
                          accentColor={activePlatform.color}
                        />
                      ))
                    : (
                      <div style={S.emptyText}>
                        该博主暂无笔记详情，仅有 {group.cards.length} 张卡片数据
                      </div>
                    );
                })()}
              </>
            ) : (
              // Creator grouping list
              userGroups.map((group) => (
                <UserGroupCard
                  key={group.user_id}
                  group={group}
                  checked={selectedUsers.has(group.user_id)}
                  onToggle={() => toggleUser(group.user_id)}
                  onClick={() => setExpandedUser(group.user_id)}
                  accentColor={activePlatform.color}
                />
              ))
            )
          )}

        </div>

        {/* Send receipt */}
        {sendStatus && <div style={S.sendStatus}>{sendStatus}</div>}

        {/* Bottom action bar */}
        <div style={S.bottomBar}>
          <button
            style={selectionCount > 0 && !sending
              ? { ...S.btnExport, backgroundColor: activePlatform.color }
              : S.btnExportDisabled}
            onClick={() => void handleExport()}
            disabled={selectionCount === 0 || sending}
          >
            {sending
              ? "⏳ 发送中…"
              : bridge.token
                ? `⚡ 发送到 RemixClip (${selectionCount})`
                : `📥 导出选中 (${selectionCount})`}
          </button>
          <button
            style={S.btnIcon}
            title="下载 JSON 文件"
            aria-label="下载 JSON 文件"
            onClick={handleDownload}
            disabled={selectionCount === 0}
          >
            ⬇️
          </button>
          <button style={S.btnClear} onClick={handleClear} title="清空当前平台数据" aria-label="清空当前平台数据">
            🗑️
          </button>
        </div>
      </div>

      {bridgeOpen && (
        <div style={S.bridgeOverlay} onClick={() => setBridgeOpen(false)}>
          <div style={S.bridgeCard} onClick={(event) => event.stopPropagation()}>
            <div style={S.bridgeHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ ...S.dot, backgroundColor: bridge.token ? "#22c55e" : "#c4c4c4" }} />
                <strong style={{ fontSize: 14 }}>RemixClip 素材库</strong>
              </div>
              <button style={S.bridgeClose} onClick={() => setBridgeOpen(false)} aria-label="关闭">×</button>
            </div>

            {bridge.token ? (
              <>
                <p style={S.bridgeHelp}>
                  已绑定。之后在插件里点「发送到 RemixClip」，封面、文案、评论会直接进入工作台的素材库。
                </p>
                <div style={S.bridgeInfoRow}><span>地址</span><code style={S.bridgeCode}>{bridge.endpoint}</code></div>
                {bridge.deviceName && <div style={S.bridgeInfoRow}><span>设备</span><span>{bridge.deviceName}</span></div>}
                <div style={S.bridgeActions}>
                  <button
                    style={S.btnSecondary}
                    onClick={() => { void chrome.tabs.create({ url: bridge.endpoint }); }}
                  >
                    打开 RemixClip
                  </button>
                  <button style={S.btnDanger} onClick={() => void handleDisconnect()}>断开</button>
                </div>
              </>
            ) : (
              <>
                <p style={S.bridgeHelp}>
                  在 RemixClip 顶部切到「素材库」→「连接浏览器插件」→ 点「开启自动连接」，然后回到这里点下面的按钮即可。
                </p>
                <div style={S.bridgeStatus}>
                  <span style={{ ...S.dot, backgroundColor: bridgeOnline ? "#22c55e" : "#c4c4c4" }} />
                  {bridgeOnline === null
                    ? "正在检查应用…"
                    : bridgeOnline
                      ? "RemixClip 在线"
                      : "没连上 RemixClip，请确认应用已启动"}
                </div>
                {bridgeError && <p style={S.bridgeError}>{bridgeError}</p>}
                <div style={S.bridgeActions}>
                  <button
                    style={{ ...S.btnExport, backgroundColor: "#111", opacity: bridgeBusy ? 0.5 : 1 }}
                    disabled={bridgeBusy}
                    onClick={() => void handleAutoPair()}
                  >
                    {bridgeBusy ? "连接中…" : "连接 RemixClip"}
                  </button>
                </div>
                <button style={S.bridgeLink} onClick={() => setManualPairOpen((open) => !open)}>
                  {manualPairOpen ? "收起手动配对" : "手动填配对码"}
                </button>
                {manualPairOpen && (
                  <>
                    <label style={S.fieldLabel}>服务地址</label>
                    <input
                      style={S.fieldInput}
                      value={endpointDraft}
                      spellCheck={false}
                      placeholder={DEFAULT_REMIXCLIP_ENDPOINT}
                      onChange={(event) => setEndpointDraft(event.target.value)}
                    />
                    <label style={S.fieldLabel}>配对码</label>
                    <input
                      style={{ ...S.fieldInput, letterSpacing: 4, fontWeight: 700 }}
                      value={pairCode}
                      maxLength={6}
                      placeholder="ABC123"
                      onChange={(event) => setPairCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                    />
                    <div style={S.bridgeActions}>
                      <button
                        style={{ ...S.btnSecondary }}
                        disabled={bridgeBusy || !pairCode.trim()}
                        onClick={() => void handlePair()}
                      >
                        用配对码连接
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Subcomponents ──

function EmptyState({ text }: { text: string }) {
  return (
    <div style={S.empty}>
      <p style={{ fontSize: 36, margin: 0 }}>📡</p>
      <p style={S.emptyText}>{text}</p>
    </div>
  );
}

function UserGroupCard({
  group,
  checked,
  onToggle,
  onClick,
  accentColor,
}: {
  group: {
    user_id: string;
    user_name: string;
    notes: NoteEntry[];
    cards: NoteCard[];
    total: number;
  };
  checked: boolean;
  onToggle: () => void;
  onClick: () => void;
  accentColor: string;
}) {
  return (
    <div
      style={{
        ...S.userGroupCard,
        ...(checked ? { borderColor: accentColor, backgroundColor: accentColor + "08" } : {}),
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: "pointer", flexShrink: 0 }}
      />
      <div style={{ ...S.userGroupAvatar, backgroundColor: accentColor }} onClick={onClick}>
        {group.user_name.slice(0, 1).toUpperCase()}
      </div>
      <div style={S.userGroupBody} onClick={onClick}>
        <div style={S.userGroupName}>@{group.user_name}</div>
        <div style={S.userGroupMeta}>
          {group.notes.length > 0 && `${group.notes.length} 篇详情`}
          {group.notes.length > 0 && group.cards.length > 0 && " · "}
          {group.cards.length > 0 && `${group.cards.length} 张卡片`}
        </div>
      </div>
      <span style={S.userGroupArrow} onClick={onClick}>›</span>
    </div>
  );
}

function NoteItem({
  note,
  checked,
  commentCount,
  onToggle,
  accentColor,
}: {
  note: NoteEntry;
  checked: boolean;
  commentCount: number;
  onToggle: () => void;
  accentColor: string;
}) {
  const title = note.title || note.desc?.slice(0, 40) || "(无标题)";
  const time = note.time
    ? new Date(note.time).toLocaleDateString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

  const hasVideo = note.type === "video";
  const hasImages = note.images && note.images.some((u) => u);
  const coverUrl = hasImages
    ? note.images.find((u) => u)
    : note.video?.first_frame_fileid
      ? (note.video.first_frame_fileid.startsWith("http")
          ? note.video.first_frame_fileid
          : `https://sns-img-bd.xhscdn.com/${note.video.first_frame_fileid}`)
      : undefined;

  return (
    <div
      style={{
        ...S.noteCard,
        ...(checked ? { borderColor: accentColor, backgroundColor: accentColor + "08" } : {}),
      }}
      onClick={onToggle}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        style={S.noteCheckbox}
      />

      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          style={S.noteCover}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div style={S.noteCoverPlaceholder}>{hasVideo ? "🎬" : "📝"}</div>
      )}

      <div style={S.noteBody}>
        <div style={S.noteTitle}>
          {hasVideo && <span style={S.videoBadge}>视频</span>}
          {title}
        </div>
        {note.author && <div style={S.noteAuthor}>@{note.author}</div>}
        <div style={S.noteMeta}>
          <span>❤️ {note.like_count}</span>
          <span>⭐ {note.collect_count}</span>
          <span>💬 {note.comment_count}</span>
          {commentCount > 0 && (
            <span style={S.commentCaptured}>(已采 {commentCount})</span>
          )}
        </div>
        <div style={S.noteTime}>
          {time}
          {note.ip_location && ` · ${note.ip_location}`}
        </div>
      </div>
    </div>
  );
}

// ── Styles ──

const S: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    height: "100vh",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: "#333",
    backgroundColor: "#f5f5f5",
    fontSize: 13,
  },

  // ── Left navigation ──
  sidebar: {
    width: 56,
    minWidth: 56,
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    backgroundColor: "#fafafa",
    borderRight: "1px solid #e8e8e8",
    paddingTop: 12,
  },
  sidebarTop: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 4,
    width: "100%",
    padding: "0 4px",
  },
  platformBtn: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: 2,
    width: 48,
    padding: "8px 0",
    border: "2px solid transparent",
    borderRadius: 10,
    backgroundColor: "transparent",
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  platformBtnDisabled: {
    opacity: 0.4,
    cursor: "not-allowed",
  },
  platformIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  platformIconImg: {
    width: 22,
    height: 22,
    borderRadius: 4,
    objectFit: "contain" as const,
  },
  platformLabel: {
    fontSize: 9,
    lineHeight: 1,
    whiteSpace: "nowrap" as const,
  },

  // ── Right main area ──
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    minWidth: 0,
    overflow: "hidden" as const,
  },

  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    backgroundColor: "#fff",
    borderBottom: "1px solid #e8e8e8",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 6 },
  headerIcon: { fontSize: 18 },
  headerIconImg: {
    width: 20,
    height: 20,
    borderRadius: 3,
    objectFit: "contain" as const,
  },
  headerTitle: { fontSize: 15, fontWeight: 700 },
  headerBadge: {
    fontSize: 10,
    padding: "2px 8px",
    borderRadius: 10,
    backgroundColor: "#e8f5e9",
    color: "#4caf50",
    fontWeight: 600,
  },

  tabBar: {
    display: "flex",
    backgroundColor: "#fff",
    borderBottom: "1px solid #e8e8e8",
  },
  tab: {
    flex: 1,
    padding: "9px 0",
    border: "none",
    borderBottom: "2px solid transparent",
    backgroundColor: "transparent",
    color: "#999",
    fontSize: 12,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "center" as const,
  },
  tabActive: {
    flex: 1,
    padding: "9px 0",
    border: "none",
    borderBottom: "2px solid #ff6b6b",
    backgroundColor: "transparent",
    color: "#ff6b6b",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "center" as const,
  },

  toolbar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 14px",
    backgroundColor: "#fff",
    borderBottom: "1px solid #f0f0f0",
    fontSize: 11,
  },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 5, cursor: "pointer", color: "#666" },
  checkbox: { cursor: "pointer" },
  selectedCount: { color: "#ff6b6b", fontWeight: 600 },

  listContainer: { flex: 1, overflowY: "auto" as const, padding: "6px 10px" },

  empty: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    color: "#bbb",
  },
  emptyText: { fontSize: 12, textAlign: "center" as const, lineHeight: 1.6, color: "#bbb" },

  // User group card
  userGroupCard: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    marginBottom: 5,
    backgroundColor: "#fff",
    borderRadius: 8,
    border: "1px solid #eee",
    cursor: "pointer",
  },
  userGroupAvatar: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    backgroundColor: "#ff6b6b",
    color: "#fff",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 15,
    fontWeight: 700,
    flexShrink: 0,
  },
  userGroupBody: { flex: 1, minWidth: 0 },
  userGroupName: { fontSize: 13, fontWeight: 600, color: "#333" },
  userGroupMeta: { fontSize: 10, color: "#999", marginTop: 2 },
  userGroupArrow: { fontSize: 18, color: "#ccc", flexShrink: 0 },

  backBtn: {
    padding: "6px 10px",
    marginBottom: 6,
    border: "1px solid #e0e0e0",
    borderRadius: 6,
    backgroundColor: "#fff",
    color: "#666",
    fontSize: 11,
    cursor: "pointer",
    alignSelf: "flex-start",
  },

  // Note card
  noteCard: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    marginBottom: 5,
    backgroundColor: "#fff",
    borderRadius: 8,
    border: "1px solid #eee",
    cursor: "pointer",
  },
  noteCardChecked: { borderColor: "#ff6b6b", backgroundColor: "#fff8f8" },
  noteCheckbox: { marginTop: 4, cursor: "pointer", flexShrink: 0 },

  noteCover: {
    width: 48,
    height: 48,
    borderRadius: 6,
    objectFit: "cover" as const,
    flexShrink: 0,
    backgroundColor: "#f0f0f0",
  },
  noteCoverPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 6,
    flexShrink: 0,
    backgroundColor: "#f5f5f5",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
  },

  noteBody: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column" as const, gap: 2 },
  noteTitle: {
    fontSize: 12,
    fontWeight: 600,
    overflow: "hidden" as const,
    textOverflow: "ellipsis" as const,
    whiteSpace: "nowrap" as const,
  },
  videoBadge: {
    display: "inline-block",
    fontSize: 9,
    padding: "1px 4px",
    borderRadius: 3,
    backgroundColor: "#e3f2fd",
    color: "#1976d2",
    fontWeight: 600,
    marginRight: 3,
  },
  noteAuthor: { fontSize: 10, color: "#999" },
  noteMeta: { display: "flex", gap: 6, fontSize: 10, color: "#888" },
  commentCaptured: { color: "#4caf50", fontWeight: 500 },
  noteTime: { fontSize: 9, color: "#bbb" },

  bottomBar: {
    display: "flex",
    gap: 6,
    padding: "10px 12px",
    backgroundColor: "#fff",
    borderTop: "1px solid #e8e8e8",
  },
  btnExport: {
    flex: 1,
    padding: "9px 0",
    border: "none",
    borderRadius: 8,
    backgroundColor: "#ff6b6b",
    color: "#fff",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnExportDisabled: {
    flex: 1,
    padding: "9px 0",
    border: "none",
    borderRadius: 8,
    backgroundColor: "#ddd",
    color: "#999",
    fontSize: 13,
    fontWeight: 600,
    cursor: "not-allowed",
  },
  btnClear: {
    padding: "9px 12px",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    backgroundColor: "#fff",
    color: "#e74c3c",
    fontSize: 12,
    cursor: "pointer",
  },
  btnIcon: {
    padding: "9px 11px",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    backgroundColor: "#fff",
    fontSize: 12,
    cursor: "pointer",
  },

  // ── RemixClip binding ──
  bridgeButton: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 8px",
    border: "1px solid #e6e6e6",
    borderRadius: 999,
    backgroundColor: "#fff",
    color: "#444",
    fontSize: 10.5,
    fontWeight: 600,
    cursor: "pointer",
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    flexShrink: 0,
    backgroundColor: "#c4c4c4",
  },
  sendStatus: {
    margin: "0 12px 8px",
    padding: "7px 10px",
    borderRadius: 8,
    backgroundColor: "#f2f6ff",
    color: "#3d5a99",
    fontSize: 11,
    lineHeight: 1.5,
  },
  bridgeOverlay: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    backgroundColor: "rgba(20, 20, 20, 0.32)",
  },
  bridgeCard: {
    width: "100%",
    maxWidth: 360,
    maxHeight: "90vh",
    overflowY: "auto",
    padding: 16,
    borderRadius: 14,
    backgroundColor: "#fff",
    boxShadow: "0 24px 60px rgba(0,0,0,0.22)",
  },
  bridgeHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  bridgeClose: {
    border: "none",
    background: "transparent",
    color: "#999",
    fontSize: 20,
    lineHeight: 1,
    padding: 2,
    cursor: "pointer",
  },
  bridgeHelp: {
    margin: "0 0 12px",
    color: "#777",
    fontSize: 11.5,
    lineHeight: 1.65,
  },
  fieldLabel: {
    display: "block",
    margin: "10px 0 4px",
    color: "#666",
    fontSize: 11,
    fontWeight: 600,
  },
  fieldInput: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    border: "1px solid #e2e2e2",
    borderRadius: 8,
    backgroundColor: "#fafafa",
    color: "#222",
    fontSize: 12.5,
    outline: "none",
  },
  bridgeStatus: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 10,
    color: "#888",
    fontSize: 11,
  },
  bridgeError: {
    margin: "8px 0 0",
    padding: "6px 8px",
    borderRadius: 6,
    backgroundColor: "#fff1f0",
    color: "#c0392b",
    fontSize: 11,
    lineHeight: 1.5,
  },
  bridgeActions: {
    display: "flex",
    gap: 6,
    marginTop: 14,
  },
  bridgeLink: {
    marginTop: 10,
    padding: 0,
    border: "none",
    background: "transparent",
    color: "#888",
    fontSize: 11.5,
    textDecoration: "underline",
    cursor: "pointer",
  },
  bridgeInfoRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 0",
    borderBottom: "1px solid #f2f2f2",
    color: "#555",
    fontSize: 11.5,
  },
  bridgeCode: {
    marginLeft: "auto",
    padding: "2px 6px",
    borderRadius: 4,
    backgroundColor: "#f5f5f5",
    color: "#333",
    fontSize: 11,
  },
  btnSecondary: {
    flex: 1,
    padding: "8px 0",
    border: "1px solid #e0e0e0",
    borderRadius: 8,
    backgroundColor: "#fff",
    color: "#444",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
  btnDanger: {
    padding: "8px 14px",
    border: "1px solid #f0d4d0",
    borderRadius: 8,
    backgroundColor: "#fff7f6",
    color: "#c0392b",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  },
};

export default App;
