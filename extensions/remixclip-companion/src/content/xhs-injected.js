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

  // Initialize the context
  updateContext();

  console.log("[RemixClip] main world 被动嗅探已注入 ✓ (context tracking enabled)");
})();
