// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 RemixClip

/**
 * Script injected into YouTube's main world.
 *
 * YouTube keeps everything the player knows in `window.ytInitialPlayerResponse` (title, channel,
 * duration, thumbnails, progressive/adaptive stream URLs). The content script cannot read page
 * globals, so this bridge trims the response and posts it back over postMessage.
 *
 * Only the video whose id is in the URL is ever reported; watch pages and shorts, nothing else.
 */

(function () {
  "use strict";

  var MESSAGE_TYPE = "REMIXCLIP_YT_POST";

  function currentVideoId() {
    if (window.location.pathname === "/watch") {
      return new URLSearchParams(window.location.search).get("v");
    }
    var short = /^\/shorts\/([\w-]+)/.exec(window.location.pathname);
    return short ? short[1] : null;
  }

  /**
   * `ytInitialPlayerResponse` is replaced on SPA navigation, and `ytplayer.config.args` keeps a
   * second copy; read whichever is present so a cached navigation still reports.
   */
  function playerResponse() {
    var candidates = [window.ytInitialPlayerResponse];
    try {
      var args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args;
      if (args && typeof args.player_response === "string") {
        candidates.push(JSON.parse(args.player_response));
      }
    } catch (error) {
      // A broken copy must never break the page's own player.
    }
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] && typeof candidates[i] === "object") return candidates[i];
    }
    return null;
  }

  function largestThumbnail(thumbnails) {
    var best = "";
    if (!Array.isArray(thumbnails)) return best;
    for (var i = 0; i < thumbnails.length; i += 1) {
      var item = thumbnails[i];
      if (item && typeof item.url === "string") best = item.url;
    }
    return best;
  }

  /**
   * Only progressive/adaptive MP4 is worth handing to the downloader: WebM needs a container
   * conversion and HLS needs muxing, while a plain mp4 is playable as soon as it lands.
   */
  function streamCandidates(streaming) {
    var out = [];
    var push = function (item, hasAudio) {
      if (!item || typeof item !== "object") return;
      var url = typeof item.url === "string" ? item.url : "";
      if (!/^https?:\/\//i.test(url)) return;
      var mime = String(item.mimeType || "");
      if (!/^video\//i.test(mime) || !/mp4/i.test(mime)) return;
      out.push({
        url: url,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        hasAudio: hasAudio,
      });
    };
    if (streaming && Array.isArray(streaming.formats)) {
      streaming.formats.forEach(function (item) {
        push(item, true);
      });
    }
    if (streaming && Array.isArray(streaming.adaptiveFormats)) {
      streaming.adaptiveFormats.forEach(function (item) {
        push(item, false);
      });
    }
    // Progressive first (picture + sound), then the tallest rendition.
    out.sort(function (left, right) {
      if (left.hasAudio !== right.hasAudio) return left.hasAudio ? -1 : 1;
      return right.height - left.height;
    });
    return out.slice(0, 6);
  }

  function buildPayload() {
    var id = currentVideoId();
    if (!id) return null;

    var response = playerResponse();
    var details = (response && response.videoDetails) || {};
    var micro = (response && response.microformat && response.microformat.playerMicroformatRenderer) || {};

    var title = details.title || micro.title || "";
    var author = details.author || micro.ownerChannelName || "";
    var description = details.shortDescription || "";
    var poster =
      largestThumbnail(details.thumbnail && details.thumbnail.thumbnails) ||
      largestThumbnail(micro.thumbnail && micro.thumbnail.thumbnails);
    var duration = Number(details.lengthSeconds) || 0;

    var videos = streamCandidates(response && response.streamingData).map(function (video) {
      return { url: video.url, width: video.width, height: video.height, duration: duration };
    });

    // Without player data the page may still have painted the player; leave the report empty and
    // let the content script's DOM fallback handle it.
    if (!title && videos.length === 0 && !poster) return null;

    var profileUrl = typeof micro.ownerProfileUrl === "string" ? micro.ownerProfileUrl : "";
    var username = profileUrl ? profileUrl.replace(/\/+$/, "").split("/").pop() || "" : "";

    return {
      id: id,
      title: title,
      description: description,
      images: poster ? [poster] : [],
      videos: videos,
      creator: { id: details.channelId || "", username: username, full_name: author },
      stats: { likes: 0, comments: 0, saves: 0, shares: 0 },
      created_at: micro.publishDate || micro.uploadDate || "",
      tags: Array.isArray(details.keywords) ? details.keywords.slice(0, 20) : [],
    };
  }

  var lastSignature = "";

  function report() {
    try {
      var payload = buildPayload();
      if (!payload) return;
      var signature =
        payload.id +
        ":" +
        (payload.videos[0] ? payload.videos[0].url.slice(0, 120) : payload.images[0] || "");
      if (signature === lastSignature) return;
      lastSignature = signature;
      window.postMessage(
        { type: MESSAGE_TYPE, payload: payload, pageUrl: window.location.href },
        "*"
      );
    } catch (error) {
      // Sniffing must never surface as a page error.
    }
  }

  // YouTube is a SPA: each navigation swaps the player response, so reset and re-read.
  window.addEventListener("yt-navigate-finish", function () {
    lastSignature = "";
    window.setTimeout(report, 400);
  });
  window.setInterval(report, 1500);
  report();
})();
