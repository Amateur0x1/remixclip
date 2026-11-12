// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  loadData,
  type SnifferData,
  type NoteEntry,
  type NoteCard,
} from "./store/sniffer-store";
import type { PlatformKey } from "./types/common";
import {
  DEFAULT_REMIXCLIP_PORT,
  detectRemixclip,
  greetRemixclip,
  loadRemixclipConfig,
  parsePort,
  pingRemixclip,
  portCandidates,
  saveRemixclipConfig,
  sendToRemixclip,
  type RemixclipExportPayload,
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
  { key: "pinterest", label: "Pinterest", icon: "📌", color: "#e60023", enabled: true },
];

/** Determine whether icon is an image path or an emoji */
function isImageIcon(icon: string): boolean {
  return icon.startsWith("/") || icon.startsWith(".");
}

type TabKey = "explore" | "user";

function App() {
  const [platform, setPlatform] = useState<PlatformKey>("xhs");
  /** Rail hover: inline styles cannot express :hover, and the tile tint must not fight the selected state. */
  const [hoveredPlatform, setHoveredPlatform] = useState<PlatformKey | null>(null);
  const [data, setData] = useState<SnifferData | null>(null);
  const [tab, setTab] = useState<TabKey>("explore");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** user_id of the selected creator in the creator tab */
  const [selectedUsers, setSelectedUsers] = useState<Set<string>>(new Set());
  /** Creator currently expanded in the user tab */
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  // ── RemixClip connection (port only) ──
  const [port, setPort] = useState<number | null>(null);
  const [portDraft, setPortDraft] = useState(String(DEFAULT_REMIXCLIP_PORT));
  const [linkStatus, setLinkStatus] = useState<"checking" | "online" | "offline">("checking");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendStatus, setSendStatus] = useState("");
  /** Last port that answered; callbacks read the ref so they never close over a stale value. */
  const portRef = useRef<number | null>(null);
  /** The blocking prompt is shown once per offline episode, so 「先离线使用」 actually sticks. */
  const promptedRef = useRef(false);

  const activePlatform = PLATFORMS.find((p) => p.key === platform)!;

  const refresh = useCallback(async () => {
    try {
      const d = await loadData(platform);
      setData(d);
    } catch (err) {
      console.error("加载数据失败:", err);
    }
  }, [platform]);

  /**
   * The whole "connection" flow: try the remembered port, then the defaults. No handshake, no
   * token — the daemon answering on a port is the connection.
   */
  const checkConnection = useCallback(async (options: { prompt?: boolean; announce?: boolean } = {}) => {
    setChecking(true);
    setLinkStatus("checking");
    setLinkError("");
    const found = await detectRemixclip(portRef.current);
    setChecking(false);
    if (found == null) {
      setLinkStatus("offline");
      if (options.prompt && !promptedRef.current) {
        promptedRef.current = true;
        setLinkOpen(true);
      }
      if (options.announce) {
        setSendStatus(`没有检测到 RemixClip（已试 ${portCandidates(portRef.current).join(" / ")}）`);
      }
      return null;
    }
    portRef.current = found;
    setPort(found);
    setPortDraft(String(found));
    setLinkStatus("online");
    setLinkError("");
    promptedRef.current = false;
    await saveRemixclipConfig({ port: found });
    void greetRemixclip(found);
    if (options.announce) setSendStatus(`已连接 RemixClip（端口 ${found}）`);
    return found;
  }, []);

  // Every panel open (the side panel mounts on open) probes the daemon once; a miss opens the
  // blocking port prompt instead of letting 「发送」 fail later with a generic network error.
  useEffect(() => {
    void loadRemixclipConfig().then(async (config) => {
      portRef.current = config.port;
      setPortDraft(String(config.port));
      await checkConnection({ prompt: true });
    });
  }, [checkConnection]);

  // Coming back to the panel re-checks: the app may have been started/restarted meanwhile.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkConnection({ prompt: true });
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [checkConnection]);

  // While connected, a light heartbeat keeps the app's dialog honest and notices a dead daemon.
  useEffect(() => {
    if (linkStatus !== "online") return;
    const timer = setInterval(async () => {
      const current = portRef.current;
      if (current == null) return;
      if (await pingRemixclip(current)) {
        void greetRemixclip(current);
        return;
      }
      setLinkStatus("offline");
      setLinkOpen(true);
    }, 15_000);
    return () => clearInterval(timer);
  }, [linkStatus]);

  // Offline: keep watching quietly, so starting the app after opening the panel connects by itself
  // (this also closes the port prompt) instead of leaving the user stuck on 「没有检测到」.
  useEffect(() => {
    if (linkStatus !== "offline") return;
    const timer = setInterval(async () => {
      const found = await detectRemixclip(portRef.current);
      if (found == null) return;
      portRef.current = found;
      setPort(found);
      setPortDraft(String(found));
      setLinkStatus("online");
      setLinkError("");
      promptedRef.current = false;
      await saveRemixclipConfig({ port: found });
      void greetRemixclip(found);
      setLinkOpen(false);
      setSendStatus(`已连接 RemixClip（端口 ${found}）`);
    }, 5_000);
    return () => clearInterval(timer);
  }, [linkStatus]);

  useEffect(() => {
    if (!sendStatus) return;
    const timer = setTimeout(() => setSendStatus(""), 8000);
    return () => clearTimeout(timer);
  }, [sendStatus]);

  useEffect(() => {
    const channel = chrome.runtime.connect({ name: "sidepanel" });
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
      channel.disconnect();
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

  // Main button: when connected, push straight to the library; otherwise open the port prompt.
  // There is no loose JSON fallback — "export" here means "into RemixClip".
  const handleExport = useCallback(async () => {
    const built = buildExportPayload();
    if (!built) return;

    const current = portRef.current;
    if (linkStatus !== "online" || current == null) {
      setLinkError("");
      setLinkOpen(true);
      setSendStatus("还没连上 RemixClip：连上后选中的内容会直接进入素材库（离线期间采集不会丢）。");
      return;
    }

    setSending(true);
    setSendStatus("");
    try {
      const result = await sendToRemixclip(current, built.payload);
      setSendStatus(`已发送到 RemixClip：${result.itemCount} 条（新增 ${result.created}，更新 ${result.updated}）`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "发送失败";
      setSendStatus(message);
      // Connectivity problems are fixed in the port card, so surface it right there.
      if (message.includes("连不上")) {
        setLinkStatus("offline");
        setLinkError(message);
        setLinkOpen(true);
      }
    } finally {
      setSending(false);
    }
  }, [buildExportPayload, linkStatus]);

  const handleDownload = useCallback(() => {
    const built = buildExportPayload();
    if (!built) return;
    downloadJson(built.payload, built.filename);
    setSendStatus("已下载 JSON 文件");
  }, [buildExportPayload]);

  /** Manual fallback: probe exactly the port the user typed, and remember it on success. */
  const handleConnect = useCallback(async () => {
    const parsed = parsePort(portDraft);
    if (parsed == null) {
      setLinkError(`请输入 1-65535 之间的端口号（当前：${portDraft.trim() || "空"}）`);
      return;
    }
    setChecking(true);
    setLinkError("");
    const online = await pingRemixclip(parsed);
    setChecking(false);
    if (!online) {
      setLinkStatus("offline");
      setLinkError(`端口 ${parsed} 上没有检测到 RemixClip，确认应用已启动、端口号没填错`);
      return;
    }
    portRef.current = parsed;
    setPort(parsed);
    setLinkStatus("online");
    setLinkOpen(false);
    promptedRef.current = false;
    await saveRemixclipConfig({ port: parsed });
    await greetRemixclip(parsed);
    setSendStatus(`已连接 RemixClip（端口 ${parsed}）`);
  }, [portDraft]);

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
          {PLATFORMS.map((p) => {
            const active = platform === p.key;
            return (
            <button
              key={p.key}
              type="button"
              className="rc-tile"
              aria-current={active ? "true" : undefined}
              title={p.enabled ? p.label : `${p.label}（即将支持）`}
              style={{
                ...S.platformBtn,
                // Always spell out both properties: React diffs inline styles by longhand, so
                // omitting borderColor here is what turned the previous tile's border black.
                backgroundColor: active
                  ? p.color + "18"
                  : hoveredPlatform === p.key ? "rgba(17, 17, 17, 0.04)" : "transparent",
                borderColor: active ? p.color : "transparent",
                ...(p.enabled ? {} : S.platformBtnDisabled),
              }}
              onMouseEnter={() => setHoveredPlatform(p.key)}
              onMouseLeave={() => setHoveredPlatform((current) => (current === p.key ? null : current))}
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
                color: active ? p.color : (p.enabled ? "#666" : "#ccc"),
                fontWeight: active ? 700 : 400,
              }}>
                {p.label}
              </span>
            </button>
            );
          })}
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
              title={
                linkStatus === "online" && port
                  ? `已连接 · 端口 ${port}`
                  : "连接 RemixClip（自动检测端口）"
              }
              onClick={() => {
                setLinkOpen(true);
                if (linkStatus !== "online") void checkConnection({ prompt: false });
              }}
            >
              <span
                style={{
                  ...S.dot,
                  backgroundColor:
                    linkStatus === "online" ? "#22c55e" : linkStatus === "checking" ? "#f59e0b" : "#c4c4c4",
                }}
              />
              {linkStatus === "online" && port ? `RemixClip :${port}` : "RemixClip"}
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
              : linkStatus === "online"
                ? `⚡ 发送到 RemixClip (${selectionCount})`
                : `🔗 连接后发送 (${selectionCount})`}
          </button>
          <button
            style={S.btnIcon}
            title="手动导出 JSON 文件"
            aria-label="手动导出 JSON 文件"
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

      {linkOpen && (
        <div style={S.bridgeOverlay} onClick={() => setLinkOpen(false)}>
          <div style={S.bridgeCard} onClick={(event) => event.stopPropagation()}>
            <div style={S.bridgeHeader}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{
                    ...S.dot,
                    backgroundColor:
                      linkStatus === "online" ? "#22c55e" : linkStatus === "checking" ? "#f59e0b" : "#c4c4c4",
                  }}
                />
                <strong style={{ fontSize: 14 }}>RemixClip 素材库</strong>
              </div>
              <button style={S.bridgeClose} onClick={() => setLinkOpen(false)} aria-label="关闭">×</button>
            </div>

            <p style={S.bridgeHelp}>
              {linkStatus === "online"
                ? "已连接。勾选内容点「发送到 RemixClip」，封面、文案、评论会直接进入工作台的素材库。"
                : "插件打开时会自动检测本机的 RemixClip。没检测到时，请先启动应用；如果应用用的不是默认端口，填入它的端口号再检测。"}
            </p>

            <div style={S.bridgeStatus}>
              <span
                style={{
                  ...S.dot,
                  backgroundColor:
                    linkStatus === "online" ? "#22c55e" : linkStatus === "checking" ? "#f59e0b" : "#c4c4c4",
                }}
              />
              {checking
                ? "正在检测…"
                : linkStatus === "online"
                  ? `已连接 · 端口 ${port}`
                  : "没有检测到 RemixClip"}
            </div>

            <label style={S.fieldLabel} htmlFor="remixclip-port">端口号</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="remixclip-port"
                style={{ ...S.fieldInput, flex: 1 }}
                value={portDraft}
                inputMode="numeric"
                maxLength={5}
                spellCheck={false}
                aria-label="端口号"
                placeholder={String(DEFAULT_REMIXCLIP_PORT)}
                onChange={(event) => setPortDraft(event.target.value.replace(/\D/g, "").slice(0, 5))}
                onKeyDown={(event) => { if (event.key === "Enter") void handleConnect(); }}
              />
              <button
                style={{
                  ...S.btnExport,
                  flex: "0 0 auto",
                  padding: "8px 14px",
                  backgroundColor: "#111",
                  opacity: checking ? 0.5 : 1,
                }}
                disabled={checking}
                onClick={() => void handleConnect()}
              >
                {checking ? "检测中…" : "检测并连接"}
              </button>
            </div>
            <p style={S.bridgeHint}>
              默认 {DEFAULT_REMIXCLIP_PORT}；应用里「设置 → 浏览器插件」的端口可直接复制，填同一个数字即可。自动尝试：
              {portCandidates(portRef.current).join(" / ")}
            </p>

            {linkError && <p style={S.bridgeError}>{linkError}</p>}

            <div style={S.bridgeActions}>
              {linkStatus === "online" ? (
                <>
                  <button
                    style={S.btnSecondary}
                    onClick={() => {
                      if (port) void chrome.tabs.create({ url: `http://127.0.0.1:${port}` });
                    }}
                  >
                    打开 RemixClip
                  </button>
                  <button
                    style={S.btnSecondary}
                    onClick={() => void checkConnection({ announce: true })}
                  >
                    重新检测
                  </button>
                </>
              ) : (
                <>
                  <button style={S.btnSecondary} onClick={() => setLinkOpen(false)}>
                    先离线使用
                  </button>
                  <button
                    style={S.btnSecondary}
                    onClick={() => void checkConnection({ announce: true })}
                  >
                    自动检测
                  </button>
                </>
              )}
            </div>
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
        borderColor: checked ? accentColor : "#eee",
        backgroundColor: checked ? accentColor + "08" : "#fff",
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
        borderColor: checked ? accentColor : "#eee",
        backgroundColor: checked ? accentColor + "08" : "#fff",
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
    // Longhands on purpose: the active state only overrides borderColor, and a `border`
    // shorthand would be expanded by the browser into width/style/image — removing the color
    // later then falls back to currentColor, i.e. the black frame users saw on the old tab.
    borderWidth: 2,
    borderStyle: "solid" as const,
    borderColor: "transparent",
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
    // Longhands so the active tab can override just the underline colour.
    borderWidth: 0,
    borderStyle: "none" as const,
    borderBottomWidth: 2,
    borderBottomStyle: "solid" as const,
    borderBottomColor: "transparent",
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
    borderWidth: 0,
    borderStyle: "none" as const,
    borderBottomWidth: 2,
    borderBottomStyle: "solid" as const,
    borderBottomColor: "#ff6b6b",
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
    // Longhands: the checked state overrides borderColor only.
    borderWidth: 1,
    borderStyle: "solid" as const,
    borderColor: "#eee",
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
    // Longhands: the checked state overrides borderColor only.
    borderWidth: 1,
    borderStyle: "solid" as const,
    borderColor: "#eee",
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
  bridgeHint: {
    margin: "6px 0 0",
    color: "#999",
    fontSize: 10.5,
    lineHeight: 1.6,
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
};

export default App;
