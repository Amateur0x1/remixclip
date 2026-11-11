// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip
// Vendored from social-media-sniffer@0a68863 (extension/), modified for RemixClip.

/**
 * Script injected into the Bilibili main world.
 *
 * Intercepts Bilibili API responses and sends them to the content script bridge via
 * window.postMessage.
 *
 * Important: a single video object in Bilibili API responses also carries many redundant
 * fields, so we trim it before forwarding and keep only the core fields.
 */

(function () {
  "use strict";

  // Bilibili API path list (note: paths with the wbi/ prefix are the signed endpoints)
  var API_PATTERNS = [
    { key: "bili_playurl", path: "/x/player/wbi/playurl" },
    { key: "bili_playurl", path: "/x/player/playurl" },
    { key: "bili_video_detail", path: "/x/web-interface/view" },
    { key: "bili_rcmd", path: "/x/web-interface/wbi/index/top/feed/rcmd" },
    { key: "bili_popular", path: "/x/web-interface/popular" },
    { key: "bili_video_detail", path: "/x/web-interface/wbi/view/detail" },
    { key: "bili_video_detail", path: "/x/web-interface/view/detail" },
    { key: "bili_reply", path: "/x/v2/reply/wbi/main" },
    { key: "bili_reply", path: "/x/v2/reply/main" },
    { key: "bili_user_video", path: "/x/space/wbi/arc/search" },
    { key: "bili_user_video", path: "/x/space/arc/search" },
  ];

  // ── Data trimming ──

  function trimBiliVideo(raw) {
    if (!raw || !raw.bvid) return null;
    var owner = raw.owner || {};
    var stat = raw.stat || {};
    return {
      bvid: raw.bvid,
      aid: raw.aid,
      title: raw.title || "",
      pic: raw.pic || "",
      desc: raw.desc || "",
      duration: raw.duration || 0,
      pubdate: raw.pubdate || 0,
      tname: raw.tname || "",
      videos: raw.videos || 1,
      owner: {
        mid: owner.mid,
        name: owner.name || "",
        face: owner.face || "",
      },
      stat: {
        view: stat.view || 0,
        danmaku: stat.danmaku || 0,
        reply: stat.reply || 0,
        favorite: stat.favorite || 0,
        coin: stat.coin || 0,
        share: stat.share || 0,
        like: stat.like || 0,
      },
    };
  }

  function trimBiliReply(raw) {
    if (!raw || !raw.rpid) return null;
    var content = raw.content || {};
    var member = raw.member || {};
    var replyControl = raw.reply_control || {};
    return {
      rpid: raw.rpid,
      oid: raw.oid,
      mid: raw.mid,
      ctime: raw.ctime || 0,
      like: raw.like || 0,
      rcount: raw.rcount || 0,
      content: { message: content.message || "" },
      member: {
        mid: member.mid || "",
        uname: member.uname || "",
        avatar: member.avatar || "",
      },
      reply_control: {
        location: replyControl.location || "",
      },
    };
  }

  function trimBiliUserVideoItem(raw) {
    if (!raw || !raw.bvid) return null;
    return {
      bvid: raw.bvid,
      aid: raw.aid,
      title: raw.title || "",
      pic: raw.pic || "",
      description: raw.description || "",
      play: raw.play || 0,
      comment: raw.comment || 0,
      favorites: raw.favorites || 0,
      created: raw.created || 0,
      length: raw.length || "",
      author: raw.author || "",
      mid: raw.mid,
    };
  }

  function trimPayload(source, raw) {
    if (!raw || raw.code !== 0) return raw;

    switch (source) {
      case "bili_rcmd": {
        var items = raw.data && raw.data.item;
        if (!Array.isArray(items)) return raw;
        return {
          code: 0,
          data: {
            item: items.map(trimBiliVideo).filter(Boolean),
          },
        };
      }
      case "bili_popular": {
        var list = raw.data && raw.data.list;
        if (!Array.isArray(list)) return raw;
        return {
          code: 0,
          data: {
            list: list.map(trimBiliVideo).filter(Boolean),
            no_more: raw.data.no_more,
          },
        };
      }
      case "bili_video_detail": {
        var dataObj = raw.data;
        if (!dataObj) return raw;
        // wbi/view/detail aggregate endpoint: video info lives in data.View
        var view = dataObj.View || dataObj;
        return {
          code: 0,
          data: {
            View: trimBiliVideo(view),
          },
        };
      }
      case "bili_reply": {
        var replyData = raw.data;
        if (!replyData) return raw;
        var replies = replyData.replies;
        return {
          code: 0,
          data: {
            replies: Array.isArray(replies) ? replies.map(trimBiliReply).filter(Boolean) : null,
            cursor: replyData.cursor,
            upper: replyData.upper,
          },
        };
      }
      case "bili_user_video": {
        var spaceData = raw.data;
        if (!spaceData || !spaceData.list) return raw;
        var vlist = spaceData.list.vlist;
        return {
          code: 0,
          data: {
            list: {
              vlist: Array.isArray(vlist) ? vlist.map(trimBiliUserVideoItem).filter(Boolean) : [],
            },
            page: spaceData.page,
          },
        };
      }
      default:
        return raw;
    }
  }

  // ── Context URL tracking ──

  // When entering a video from a space page, only the "first" video inherits the space
  // context, so related recommendations do not misattribute authors
  var contextUrl = window.location.href;
  var pendingUserContext = isUserSpaceUrl(contextUrl) ? contextUrl : null;

  function isUserSpaceUrl(url) {
    // Supports both the space.bilibili.com/{mid} and www.bilibili.com/space/{mid} forms
    return /\/space\/\d+/.test(url) || /^https?:\/\/space\.bilibili\.com\/\d+/.test(url);
  }

  function isVideoDetailUrl(url) {
    return /\/video\/BV[\w]+/i.test(url);
  }

  function updateContext() {
    var currentUrl = window.location.href;

    if (isUserSpaceUrl(currentUrl)) {
      contextUrl = currentUrl;
      pendingUserContext = currentUrl;
      return;
    }

    if (isVideoDetailUrl(currentUrl)) {
      if (pendingUserContext) {
        contextUrl = pendingUserContext;
        pendingUserContext = null; // one-shot consumption
      } else {
        contextUrl = currentUrl;
      }
      return;
    }

    contextUrl = currentUrl;
    pendingUserContext = null;
  }

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
    for (var i = 0; i < API_PATTERNS.length; i++) {
      if (url.includes(API_PATTERNS[i].path)) return API_PATTERNS[i].key;
    }
    return null;
  }

  function forward(source, payload, apiUrl) {
    var trimmed = trimPayload(source, payload);
    window.postMessage(
      {
        type: "BILI_SNIFFER_DATA",
        source: source,
        payload: trimmed,
        url: apiUrl,
        pageUrl: source === "bili_playurl" ? window.location.href : contextUrl,
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
    if (source && response.ok) {
      response
        .clone()
        .text()
        .then(function (text) {
          var json = safeParse(text);
          if (json && json.code === 0) {
            console.log("[RemixClip] B站 fetch 拦截:", source, url.split("?")[0]);
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
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      var url = this._sniffUrl;
      if (!url) return;
      var source = matchApi(url);
      if (source && this.status >= 200 && this.status < 300) {
        var json = safeParse(this.responseText);
        if (json && json.code === 0) {
          console.log("[RemixClip] B站 XHR 拦截:", source, url.split("?")[0]);
          forward(source, json, url);
        }
      }
    });
    return originalXhrSend.apply(this, arguments);
  };

  // First-screen playback info is usually embedded by the server and may not produce an
  // interceptable request.
  function captureInitialState() {
    var state = window.__INITIAL_STATE__;
    if (state && state.videoData) {
      forward("bili_video_detail", { code: 0, data: state.videoData }, window.location.href);
    }
    var play = window.__playinfo__;
    if (play && play.code === 0) forward("bili_playurl", play, window.location.href);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", captureInitialState, { once: true });
  } else {
    captureInitialState();
  }

  // Initialize the context
  updateContext();

  console.log("[RemixClip] B站 main world 被动嗅探已注入 ✓");
})();
