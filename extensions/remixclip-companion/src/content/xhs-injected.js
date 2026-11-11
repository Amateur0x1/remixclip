// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

/**
 * Script injected into the page's main world.
 *
 * After intercepting data, sends it to the content script bridge via window.postMessage,
 * attaching the context page URL so the service worker can infer the source scenario.
 *
 * Key design: contextUrl tracking
 * Xiaohongshu is an SPA, so after a user clicks a note on a creator's profile page the URL
 * changes via pushState to /explore/{note_id}, yet the user's logical context is still
 * "viewing this creator".
 * So we remember the URL at the time of entering user/profile as contextUrl,
 * until the user truly leaves (navigates to a page that is not a note detail).
 */

(function () {
  "use strict";

  var API_PATTERNS = {
    feed: "/api/sns/web/v1/feed",
    comment: "/api/sns/web/v2/comment/page",
    user_posted: "/api/sns/web/v1/user_posted",
  };

  // ── Context URL tracking ──

  // When entering a note from a profile page, only the "first" note inherits the profile
  // context.
  // A later jump from this note to someone else's note (related recommendation) is then
  // not misattributed to the original creator.
  var contextUrl = window.location.href;
  var pendingUserContext = isUserProfileUrl(contextUrl) ? contextUrl : null;

  function isUserProfileUrl(url) {
    return /\/user\/profile\/[a-f0-9]+/.test(url);
  }

  function isNoteDetailUrl(url) {
    return /\/(?:explore|discovery\/item)\/[a-f0-9]+/.test(url);
  }

  function updateContext() {
    var currentUrl = window.location.href;

    if (isUserProfileUrl(currentUrl)) {
      // Entered the creator's profile: remember the context and let the next note inherit
      // it once
      contextUrl = currentUrl;
      pendingUserContext = currentUrl;
      return;
    }

    if (isNoteDetailUrl(currentUrl)) {
      if (pendingUserContext) {
        contextUrl = pendingUserContext;
        pendingUserContext = null; // one-shot consumption
      } else {
        contextUrl = currentUrl;
      }
      return;
    }

    // Discovery page, search page, etc.: reset the context
    contextUrl = currentUrl;
    pendingUserContext = null;
  }

  // Listen to SPA route changes
  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;

  history.pushState = function () {
    var result = originalPushState.apply(this, arguments);
    updateContext();
    return result;
  };

  history.replaceState = function () {
    var result = originalReplaceState.apply(this, arguments);
    updateContext();
    return result;
  };

  window.addEventListener("popstate", function () {
    updateContext();
  });

  // ── API interception ──

  function matchApi(url) {
    for (var key in API_PATTERNS) {
      if (url.includes(API_PATTERNS[key])) return key;
    }
    return null;
  }

  function forward(source, payload, apiUrl) {
    window.postMessage(
      {
        type: "XHS_SNIFFER_DATA",
        source: source,
        payload: payload,
        url: apiUrl,
        pageUrl: contextUrl,
      },
      "*"
    );
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // ── Media request tracking ──
  //
  // The feed response sometimes ships the note without `video.media`, and the player then falls
  // back to a src the API never told us about (or a blob: MSE source). Whatever the player does,
  // it must fetch the bytes, so the request URL itself is the most reliable source of truth.

  function noteIdFromPath() {
    var match = /\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i.exec(window.location.pathname);
    return match ? match[1] : null;
  }

  function absoluteUrl(raw) {
    try {
      return new URL(String(raw), window.location.href).href;
    } catch {
      return "";
    }
  }

  /** Progressive clips and HLS manifests are fetchable; single MSE segments are not. */
  function isVideoUrl(url) {
    if (!url || !/^https?:/i.test(url)) return false;
    return /\.(?:mp4|m3u8)(?:\?|$)/i.test(url);
  }

  var lastVideoRequest = "";

  function reportVideoRequest(rawUrl) {
    var url = absoluteUrl(rawUrl);
    if (!isVideoUrl(url)) return;
    var noteId = noteIdFromPath();
    if (!noteId || url === lastVideoRequest) return;
    lastVideoRequest = url;
    forward("xhs_video", { note_id: noteId, src: url }, window.location.href);
  }

  /** Entries recorded before the hook was installed (full page load) still count. */
  function scanVideoResources() {
    if (!noteIdFromPath()) return;
    var entries = performance.getEntriesByType("resource");
    for (var i = entries.length - 1; i >= 0; i--) {
      if (isVideoUrl(entries[i].name)) {
        reportVideoRequest(entries[i].name);
        return;
      }
    }
  }

  setInterval(scanVideoResources, 3000);

  // ── Monkey-patch fetch ──

  var originalFetch = window.fetch;

  window.fetch = async function () {
    var args = arguments;
    var response = await originalFetch.apply(this, args);

    var url =
      typeof args[0] === "string"
        ? args[0]
        : args[0] instanceof Request
          ? args[0].url
          : "";

    var source = matchApi(url);
    reportVideoRequest(url);
    if (source && response.ok) {
      response
        .clone()
        .text()
        .then(function (text) {
          var json = safeParse(text);
          if (json) {
            console.log("[RemixClip] fetch 拦截:", source, url, "context:", contextUrl);
            forward(source, json, url);
          }
        })
        .catch(function () {});
    }

    return response;
  };

  // ── Monkey-patch XMLHttpRequest ──

  var originalXhrOpen = XMLHttpRequest.prototype.open;
  var originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._sniffUrl = String(url);
    reportVideoRequest(url);
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      var url = this._sniffUrl;
      if (!url) return;
      var source = matchApi(url);
      if (source && this.status >= 200 && this.status < 300) {
        var json = safeParse(this.responseText);
        if (json) {
          console.log("[RemixClip] XHR 拦截:", source, url, "context:", contextUrl);
          forward(source, json, url);
        }
      }
    });
    return originalXhrSend.apply(this, arguments);
  };

  // ── Page state fallback ──
  //
  // Some feed responses arrive without `video.media`, and some players hide their URL behind a
  // blob: src. The page's own state still holds the playable address, so report it through the
  // same channel as the API captures.

  /** Bounded deep search: play addresses move around between builds of the page. */
  function findPlayableUrl(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return null;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var found = findPlayableUrl(node[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    var direct = node.masterUrl || node.master_url || node.playUrl || node.play_url;
    if (typeof direct === "string" && /^https?:\/\//i.test(direct)) return direct;
    for (var key in node) {
      var value = node[key];
      if (value && typeof value === "object") {
        var hit = findPlayableUrl(value, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  }

  function pickStreamUrl(streams) {
    if (!streams) return null;
    if (Array.isArray(streams)) {
      for (var i = 0; i < streams.length; i++) {
        var entry = streams[i] || {};
        var direct = entry.masterUrl || entry.master_url || entry.playUrl || entry.play_url || entry.url;
        if (direct) return direct;
      }
      return null;
    }
    var codecs = ["h264", "h265", "av1", "avc", "hevc"];
    for (var c = 0; c < codecs.length; c++) {
      var list = streams[codecs[c]];
      if (!Array.isArray(list)) continue;
      for (var j = 0; j < list.length; j++) {
        var item = list[j] || {};
        var url = item.masterUrl || item.master_url || item.playUrl || item.play_url || item.url;
        if (url) return url;
      }
    }
    return streams.masterUrl || streams.master_url || null;
  }

  function videoSrcFromState(noteId) {
    var state = window.__INITIAL_STATE__;
    var holder = state && state.note && state.note.noteDetailMap && state.note.noteDetailMap[noteId];
    var note = holder && (holder.note || holder);
    var video = note && note.video;
    if (!video) return null;
    var media = video.media || {};
    return (
      pickStreamUrl(media.stream) ||
      pickStreamUrl(media.video) ||
      pickStreamUrl(video.stream) ||
      video.url || video.videoUrl || video.video_url ||
      findPlayableUrl(holder, 0) ||
      null
    );
  }

  var lastStateVideo = "";
  setInterval(function () {
    var noteId = noteIdFromPath();
    if (!noteId) return;
    var src = videoSrcFromState(noteId);
    if (!src || src === lastStateVideo) return;
    lastStateVideo = src;
    forward("xhs_video", { note_id: noteId, src: src }, window.location.href);
  }, 2000);

  // Initialize the context
  updateContext();

  console.log("[RemixClip] main world 被动嗅探已注入 ✓ (context tracking enabled)");
})();
