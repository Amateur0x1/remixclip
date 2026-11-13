// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * Script injected into Pinterest's main world.
 *
 * Pinterest is a pure client-side app: the grid, pin detail, related pins and comments all arrive
 * as JSON from `/resource/<Something>Resource/get/`. This hook reads those responses the page has
 * already requested (never issues its own request) and forwards trimmed pin objects to the content
 * script bridge.
 *
 * Trimmed shape (the service worker consumes exactly this):
 *   {
 *     id, title, description, link, created_at,
 *     images: string[],
 *     videos: [{ url, width, height, duration }],
 *     creator: { id, username, full_name, avatar_url },
 *     board: { id, name },
 *     stats: { saves, comments, likes, shares },
 *     tags: string[]
 *   }
 */

(function () {
  "use strict";

  var MESSAGE_TYPE = "PINTEREST_SNIFFER_DATA";
  var MAX_PINS_PER_RESPONSE = 60;

  function toInt(value) {
    if (typeof value === "number" && isFinite(value)) return Math.trunc(value);
    if (typeof value === "string") {
      var parsed = parseInt(value.replace(/[^\d]/g, ""), 10);
      return isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i += 1) {
      var value = arguments[i];
      if (typeof value === "string" && value.trim()) return value;
    }
    return "";
  }

  // ── Image extraction ──
  //
  // `images` is a size-keyed map: { "236x": {url,width,height}, "736x": ..., "orig": ... }.
  // Prefer the largest copy, because the library card and the agent both want the crisp one.

  var IMAGE_KEY_ORDER = ["orig", "1200x", "736x", "600x", "564x", "474x", "400x", "236x"];

  function imageEntries(raw) {
    var entries = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return entries;
    for (var key in raw) {
      var value = raw[key];
      if (!value) continue;
      if (typeof value === "string") {
        entries.push({ key: key, url: value, width: 0, height: 0 });
      } else if (typeof value === "object" && typeof value.url === "string") {
        entries.push({
          key: key,
          url: value.url,
          width: toInt(value.width),
          height: toInt(value.height),
        });
      }
    }
    entries.sort(function (a, b) {
      var ai = IMAGE_KEY_ORDER.indexOf(a.key);
      var bi = IMAGE_KEY_ORDER.indexOf(b.key);
      ai = ai < 0 ? IMAGE_KEY_ORDER.length : ai;
      bi = bi < 0 ? IMAGE_KEY_ORDER.length : bi;
      if (ai !== bi) return ai - bi;
      return (b.width || 0) - (a.width || 0);
    });
    return entries;
  }

  function pickImages(raw) {
    var urls = [];
    var add = function (url) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
      if (urls.indexOf(url) < 0) urls.push(url);
    };
    add(raw && raw.image);
    add(raw && raw.image_url);

    var maps = [raw && raw.images, raw && raw.image_medium_url];
    for (var i = 0; i < maps.length; i += 1) {
      var entries = imageEntries(maps[i]);
      for (var j = 0; j < entries.length; j += 1) add(entries[j].url);
    }
    if (Array.isArray(raw && raw.images)) {
      for (var k = 0; k < raw.images.length; k += 1) {
        var item = raw.images[k];
        add(typeof item === "string" ? item : item && (item.url || item.url_default));
      }
    }
    return urls.slice(0, 8);
  }

  // ── Video extraction ──

  function pickVideos(raw) {
    var list = (raw && raw.video_list) || (raw && raw.videos && raw.videos.video_list);
    if (!list || typeof list !== "object") return [];
    var items = [];
    for (var key in list) {
      var item = list[key];
      if (!item || typeof item !== "object") continue;
      var url = firstString(item.url, item.video_url);
      if (!/^https?:\/\//i.test(url)) continue;
      items.push({
        url: url,
        width: toInt(item.width),
        height: toInt(item.height),
        duration: toInt(item.duration),
      });
    }
    // A pin can expose the same clip as a progressive MP4 and as an HLS manifest (`V_HLSV4`).
    // Only the MP4 is a file the library can download and analyse, so drop the manifests when a
    // real file exists instead of letting the area sort pick either one at random.
    var progressive = items.filter(function (item) {
      return /\.mp4(\?|$)/i.test(item.url);
    });
    if (progressive.length > 0) items = progressive;

    items.sort(function (a, b) {
      return (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0);
    });
    return items.slice(0, 4);
  }

  // ── Tags ──

  function pickTags(raw) {
    var tags = [];
    var boardName = raw && raw.board && raw.board.name;
    if (typeof boardName === "string" && boardName.trim()) tags.push(boardName.trim());
    var list = (raw && raw.tags) || [];
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i += 1) {
        var tag = list[i];
        var name = typeof tag === "string" ? tag : tag && (tag.name || tag.tag);
        if (typeof name === "string" && name.trim() && tags.indexOf(name.trim()) < 0) {
          tags.push(name.trim());
        }
      }
    }
    return tags.slice(0, 20);
  }

  // ── Pin trimming ──

  function trimPin(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = raw.id != null ? raw.id : raw.pin_id;
    if (id == null || !/^\d+$/.test(String(id))) return null;

    var creator = raw.creator || raw.user || raw.origin_creator || {};
    var board = raw.board || {};
    var aggregated = (raw.aggregated_pin_data && raw.aggregated_pin_data.aggregated_stats) || raw.stats || {};

    return {
      id: String(id),
      title: firstString(raw.title, raw.grid_title, raw.seo_title),
      description: firstString(
        raw.description,
        raw.closeup_unified_description,
        raw.grid_description,
        raw.auto_alt_text
      ).slice(0, 2000),
      link: firstString(raw.link, raw.canonical_link),
      created_at: raw.created_at || raw.createdAt || "",
      images: pickImages(raw),
      videos: pickVideos(raw),
      creator: {
        id: creator.id != null ? String(creator.id) : "",
        username: firstString(creator.username, creator.user_name),
        full_name: firstString(creator.full_name, creator.name, creator.nickname),
        avatar_url: firstString(creator.avatar_url, creator.image),
      },
      board: {
        id: board.id != null ? String(board.id) : "",
        name: firstString(board.name, board.title),
      },
      stats: {
        saves: toInt(aggregated.saves != null ? aggregated.saves : aggregated.save_count),
        comments: toInt(
          aggregated.comments != null ? aggregated.comments : aggregated.comment_count
        ),
        likes: toInt(
          aggregated.likes != null
            ? aggregated.likes
            : aggregated.reactions != null
              ? aggregated.reactions
              : aggregated.reaction_count
        ),
        shares: toInt(aggregated.shares != null ? aggregated.shares : aggregated.share_count),
      },
      tags: pickTags(raw),
    };
  }

  /** A pin is recognizable by a numeric id plus at least one media field. */
  function looksLikePin(node) {
    if (!node || typeof node !== "object") return false;
    var id = node.id != null ? node.id : node.pin_id;
    if (id == null || !/^\d+$/.test(String(id))) return false;
    var hasImage = Boolean(
      (node.images && typeof node.images === "object") ||
        node.image ||
        node.image_url ||
        node.image_medium_url
    );
    var hasVideo = Boolean(
      (node.videos && typeof node.videos === "object") || node.video_list
    );
    return hasImage || hasVideo;
  }

  /**
   * Harvest pins from an arbitrary response body. Pinterest wraps the same pin in several
   * envelopes (`data`, `results`, `pins`, `origin_pin`, `pin_join`), so walking the tree is more
   * durable than pinning down one key per resource type.
   */
  function collectPins(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 6 || out.length >= MAX_PINS_PER_RESPONSE) {
      return;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) collectPins(node[i], out, depth + 1);
      return;
    }
    if (looksLikePin(node)) {
      var pin = trimPin(node);
      if (pin) out.push(pin);
      // A pin object also carries origin_pin / pin_join; those are separate pins worth keeping.
    }
    for (var key in node) {
      if (key === "images" || key === "videos" || key === "video_list") continue;
      collectPins(node[key], out, depth + 1);
    }
  }

  function dedupePins(pins) {
    var map = {};
    var result = [];
    for (var i = 0; i < pins.length; i += 1) {
      var pin = pins[i];
      if (map[pin.id]) continue;
      map[pin.id] = true;
      result.push(pin);
    }
    return result;
  }

  // ── Comments ──

  function trimComment(raw) {
    if (!raw || typeof raw !== "object") return null;
    var id = raw.id != null ? raw.id : raw.comment_id;
    var text = firstString(raw.text, raw.content);
    if (id == null || !text) return null;
    var user = raw.user || raw.creator || {};
    var created = raw.created_at || raw.createdAt;
    return {
      cid: String(id),
      pin_id: raw.pin_id != null ? String(raw.pin_id) : "",
      text: text,
      user_name: firstString(user.full_name, user.username, user.name),
      like_count: toInt(raw.like_count != null ? raw.like_count : raw.reactions),
      created_at: created,
      ip_label: "",
    };
  }

  function collectComments(node, out, depth) {
    if (!node || typeof node !== "object" || depth > 5 || out.length >= 200) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i += 1) collectComments(node[i], out, depth + 1);
      return;
    }
    if (node.text && (node.user || node.pin_id) && node.id != null) {
      var comment = trimComment(node);
      if (comment) out.push(comment);
    }
    for (var key in node) collectComments(node[key], out, depth + 1);
  }

  // ── Forwarding ──

  var contextUrl = window.location.href;

  function forward(source, payload, apiUrl) {
    window.postMessage(
      { type: MESSAGE_TYPE, source: source, payload: payload, url: apiUrl, pageUrl: contextUrl },
      "*"
    );
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function handleResponse(url, json) {
    if (!json || typeof json !== "object") return;

    if (url.indexOf("PinCommentResource") >= 0) {
      var comments = [];
      collectComments(json, comments, 0);
      if (comments.length > 0) {
        var openPinId = (/\/pin\/(\d+)/.exec(contextUrl) || [])[1] || "";
        console.log("[RemixClip] Pinterest 评论拦截:", comments.length, "条");
        forward("pin_comment", { pin_id: openPinId, comments: comments }, url);
      }
      return;
    }

    var pins = [];
    collectPins(json, pins, 0);
    pins = dedupePins(pins);
    if (pins.length === 0) return;

    if (pins.length === 1 && /\/pin\/\d+/.test(contextUrl)) {
      console.log("[RemixClip] Pinterest 图钉详情拦截:", pins[0].id);
      forward("pin_detail", pins[0], url);
      return;
    }

    console.log("[RemixClip] Pinterest 列表拦截:", pins.length, "条");
    forward("pin_feed", { pins: pins }, url);
  }

  function matchPinterestApi(url) {
    return typeof url === "string" && url.indexOf("/resource/") >= 0;
  }

  // ── fetch hook ──

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
    try {
      if (matchPinterestApi(url) && response.ok) {
        response
          .clone()
          .text()
          .then(function (text) {
            var json = safeParse(text);
            if (json) handleResponse(url, json);
          })
          .catch(function () {});
      }
    } catch (error) {
      // Never let sniffing break the page's own request.
    }
    return response;
  };

  // ── XHR hook ──

  var originalXhrOpen = XMLHttpRequest.prototype.open;
  var originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._sniffUrl = String(url);
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      var url = this._sniffUrl;
      if (!url || !matchPinterestApi(url)) return;
      if (this.status < 200 || this.status >= 300) return;
      var json = safeParse(this.responseText);
      if (json) handleResponse(url, json);
    });
    return originalXhrSend.apply(this, arguments);
  };

  // ── SSR / embedded state ──
  //
  // The first paint of a pin page ships the whole pin inside `__PWS_DATA__`; the resource request
  // may already have been served from the browser cache, so this is the only copy we can see.

  function extractPwsPin() {
    var pinId = (/\/pin\/(\d+)/.exec(window.location.pathname) || [])[1];
    if (!pinId) return;
    var el = document.getElementById("__PWS_DATA__");
    if (!el || !el.textContent) return;
    var data = safeParse(el.textContent);
    if (!data) return;

    var found = null;
    var visit = function (node, depth) {
      if (!node || typeof node !== "object" || depth > 8 || found) return;
      if (String(node.id) === pinId && looksLikePin(node)) {
        found = node;
        return;
      }
      for (var key in node) visit(node[key], depth + 1);
    };
    visit(data, 0);
    if (!found) return;

    var pin = trimPin(found);
    if (pin) {
      console.log("[RemixClip] Pinterest 页面内嵌数据提取:", pin.id);
      forward("pin_detail", pin, window.location.href);
    }
  }

  function schedulePwsExtraction() {
    setTimeout(extractPwsPin, 600);
    setTimeout(extractPwsPin, 2500);
  }

  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;

  history.pushState = function () {
    var result = originalPushState.apply(this, arguments);
    contextUrl = window.location.href;
    schedulePwsExtraction();
    return result;
  };

  history.replaceState = function () {
    var result = originalReplaceState.apply(this, arguments);
    contextUrl = window.location.href;
    schedulePwsExtraction();
    return result;
  };

  window.addEventListener("popstate", function () {
    contextUrl = window.location.href;
    schedulePwsExtraction();
  });

  contextUrl = window.location.href;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", schedulePwsExtraction);
  } else {
    schedulePwsExtraction();
  }

  console.log("[RemixClip] Pinterest main world 被动嗅探已注入 ✓");
})();
