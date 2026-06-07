'use strict';

/**
 * Single source of truth for every supported platform.
 *
 * ── To add a new site ────────────────────────────────────────────────────────
 *   1. Append one entry to SUPPORTED_SITES below.
 *   2. Run `node build-manifest.js` to regenerate manifest.json from this file.
 *   3. Reload the extension at chrome://extensions (manifest changes need a
 *      full reload, not just a page refresh).
 *
 * ── Entry fields ─────────────────────────────────────────────────────────────
 *   id              unique slug (internal)
 *   label           human-readable name
 *   hostPermissions every origin the extension must read — the course page AND
 *                   the subtitle/caption CDN (fed into manifest host_permissions)
 *   pageMatches     where the content script + overlay run (manifest matches)
 *   trackUrls       subtitle track requests to intercept (webRequest filter)
 *   player          CSS selector(s) for the element the overlay lives inside;
 *                   MUST survive fullscreen. First match wins.
 *   video           CSS selector(s) for the <video> element. First match wins.
 *   autoCaptions    (optional) true for Video.js sites that only fetch their
 *                   subtitle track once CC is enabled. Adds a MAIN-world script
 *                   (inject.js) that turns the track on in `hidden` mode so the
 *                   .vtt is fetched without showing the original text.
 */
const SUPPORTED_SITES = [
  {
    id: 'skilljar',
    label: 'Skilljar (e.g. Anthropic courses)',
    hostPermissions: ['*://*.skilljar.com/*', '*://assets-jpcust.jwpsrv.com/*'],
    pageMatches: ['*://*.skilljar.com/*'],
    trackUrls: ['*://assets-jpcust.jwpsrv.com/tracks/*.srt'],
    player: ['.plyr', '.jwplayer'],
    video: ['video.sbtl-video', '.jwplayer video'],
  },
  {
    id: 'frontendmasters',
    label: 'FrontendMasters',
    hostPermissions: ['*://frontendmasters.com/*', '*://captions.frontendmasters.com/*'],
    pageMatches: ['*://frontendmasters.com/*'],
    trackUrls: ['*://captions.frontendmasters.com/*.vtt'],
    player: ['.video-js'],
    video: ['video.vjs-tech'],
    autoCaptions: true, // Video.js fetches the .vtt only when CC is enabled
  },
];

// ── Helpers (shared by background.js, content.js, build-manifest.js) ──────────

// Convert a Chrome match pattern (e.g. `*://*.skilljar.com/*`) to a RegExp.
// Sufficient for our simple `*://host/path` patterns.
function matchPatternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); // escape regex specials (keep *)
  const withWildcards = escaped.replace(/\*/g, '.*');             // * → .*
  return new RegExp('^' + withWildcards + '$');
}

// The site config whose pageMatches matches the given URL, or null.
function siteForUrl(url) {
  return (
    SUPPORTED_SITES.find((site) =>
      site.pageMatches.some((p) => matchPatternToRegExp(p).test(url))
    ) || null
  );
}

// Union of every site's track-URL patterns (for the webRequest filter).
function allTrackUrls() {
  return [...new Set(SUPPORTED_SITES.flatMap((site) => site.trackUrls))];
}

// Node interop for build-manifest.js — harmless in the browser (module is undefined).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SUPPORTED_SITES, matchPatternToRegExp, siteForUrl, allTrackUrls };
}
