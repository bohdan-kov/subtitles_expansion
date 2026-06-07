'use strict';

/**
 * Runs in the PAGE's MAIN world (declared with "world": "MAIN" in the manifest)
 * on Video.js-based sites that fetch their subtitle track lazily — i.e. only
 * once the user enables CC.
 *
 * We can't reach the Video.js player from a normal (isolated-world) content
 * script: `videoEl.player` and `window.videojs` are main-world globals/expandos.
 * So this script lives in the main world and forces the captions/subtitles text
 * track into `hidden` mode. That makes the platform request its `.vtt`
 * (intercepted by background.js) WITHOUT rendering the original-language text —
 * our Ukrainian overlay is the only thing shown.
 *
 * Generic for any Video.js site; the manifest limits where it runs.
 */
(function () {
  function findPlayer() {
    const vEl = document.querySelector('video');
    if (!vEl) return null;
    if (vEl.player) return vEl.player; // Video.js stores the player on the element
    try {
      if (window.videojs) {
        return window.videojs.getPlayer ? window.videojs.getPlayer(vEl) : window.videojs(vEl);
      }
    } catch (_) {}
    return null;
  }

  function enableHiddenCaptions(player) {
    let tracks;
    try {
      tracks = player.textTracks();
    } catch (_) {
      return;
    }
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const isCaption = t.kind === 'captions' || t.kind === 'subtitles';
      // Only flip tracks that are off ('disabled'); leave 'showing'/'hidden' as-is
      // so we never fight the user or re-trigger fetches.
      if (isCaption && t.mode === 'disabled') {
        t.mode = 'hidden';
      }
    }
  }

  // Poll: the player initialises lazily, and on SPA navigation a new lesson's
  // track is added later. Cheap enough to run on a steady interval.
  setInterval(function () {
    const player = findPlayer();
    if (player) enableHiddenCaptions(player);
  }, 1000);
})();
