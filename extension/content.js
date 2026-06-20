'use strict';

const OVERLAY_ID = 'ua-subs-overlay';

// Resolved from the shared registry (sites.js is injected before this script).
// Holds the player/video selectors for whichever platform we're on.
const SITE = siteForUrl(location.href);

let uaCues = null;       // Array<{id, startSec, endSec, text}>
let uaSRT = null;        // raw translated SRT (sent to the bridge for voice-over)
let overlayEl = null;
let lastWindowSig = null; // signature of the last rendered prev|cur|next window
let settings = { enabled: true, mode: 'ua', layout: 'triple', dub: false, voice: 'uk-UA-OstapNeural', dubSpeed: 'auto' };

// First element matching any selector in the list, or null.
function firstMatch(selectors) {
  for (const sel of selectors || []) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// ── SRT parser (inlined) ─────────────────────────────────────────────────────

function parseSRT(raw) {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const cues = [];
  for (const block of text.trim().split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;
    const timeMatch = lines[1].trim().match(
      /^(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/
    );
    if (!timeMatch) continue;
    const text = lines.slice(2).join('\n').trim();
    if (!text) continue;
    cues.push({
      id: lines[0].trim(),
      startSec: toSeconds(timeMatch[1]),
      endSec: toSeconds(timeMatch[2]),
      text,
    });
  }
  return cues;
}

function toSeconds(ts) {
  const [h, m, rest] = ts.split(':');
  const [s, ms] = rest.replace('.', ',').split(',');
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}

// ── Cue window lookup (binary search) ────────────────────────────────────────

// Returns the indices of the three cues to display: the one that already
// passed (prev), the one active right now (cur, -1 during a gap between cues),
// and the upcoming one (next). This drives the 3-level overlay so the viewer
// can read ahead and catch up.
function findCueWindow(cues, t) {
  let lo = 0, hi = cues.length - 1, active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].endSec < t) lo = mid + 1;
    else if (cues[mid].startSec > t) hi = mid - 1;
    else { active = mid; break; }
  }
  // Active cue found → neighbours are its siblings.
  if (active !== -1) return { prev: active - 1, cur: active, next: active + 1 };
  // In a gap: `lo` is the first cue starting after t (upcoming), `lo - 1`
  // is the last cue that already finished. No bright current line.
  return { prev: lo - 1, cur: -1, next: lo };
}

// ── Overlay DOM ──────────────────────────────────────────────────────────────

function ensureOverlay() {
  if (overlayEl && document.contains(overlayEl)) return overlayEl;

  // Overlay must live inside the player element so it survives fullscreen.
  // Per-site selectors come from the registry; the rest is a generic fallback
  // in case a page variant isn't covered yet.
  const container =
    firstMatch(SITE?.player) ||
    document.querySelector('.plyr') ||
    document.querySelector('.jwplayer') ||
    document.querySelector('.video-js');
  if (!container) return null;

  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;

  // 3-level subtitle stack: previous (dim) · current (bright) · next (dim).
  const stack = document.createElement('div');
  stack.className = 'ua-subs-stack';
  for (const level of ['prev', 'current', 'next']) {
    const line = document.createElement('span');
    line.className = `ua-subs-line ua-subs-${level}`;
    stack.appendChild(line);
  }
  overlayEl.appendChild(stack);

  // Single line reused for loading / progress / error status messages.
  const textEl = document.createElement('span');
  textEl.className = 'ua-subs-text';
  overlayEl.appendChild(textEl);

  // Small voice-over status badge (synthesising / autoplay hint), independent of
  // the subtitle stack so it never hides the text.
  const dubEl = document.createElement('span');
  dubEl.className = 'ua-subs-dub';
  overlayEl.appendChild(dubEl);

  container.appendChild(overlayEl);
  applySettings();
  return overlayEl;
}

// Status messages (loading / progress / error) — hides the subtitle stack.
function setOverlayText(text, mode = 'loading') {
  const el = ensureOverlay();
  if (!el) return;
  el.dataset.mode = mode;
  el.querySelector('.ua-subs-text').textContent = text;
}

// Voice-over status badge — '' clears it. Independent of the subtitle stack.
function setDubBadge(text) {
  const el = ensureOverlay();
  if (!el) return;
  const badge = el.querySelector('.ua-subs-dub');
  if (badge) badge.textContent = text || '';
}

// 3-level subtitle display — shows the stack and hides the status line.
function setSubtitleLevels(prev, cur, next) {
  const el = ensureOverlay();
  if (!el) return;
  el.dataset.mode = 'subtitle';
  el.querySelector('.ua-subs-prev').textContent = prev || '';
  el.querySelector('.ua-subs-current').textContent = cur || '';
  el.querySelector('.ua-subs-next').textContent = next || '';
}

// Mark the player container so CSS can hide the platform's own captions.
// Called only once a translation is ready (so we never hide English for nothing).
function suppressNativeCaptions() {
  overlayEl?.parentElement?.classList.add('ua-subs-active');
}

function applySettings() {
  if (!overlayEl) return;
  overlayEl.style.display = settings.enabled ? '' : 'none';
  // 'triple' → prev · current · next; 'single' → current only (CSS hides the rest).
  overlayEl.dataset.layout = settings.layout || 'triple';
}

// ── Video attachment ─────────────────────────────────────────────────────────

let videoAttached = false;

function attachToVideo() {
  const video = firstMatch(SITE?.video) || document.querySelector('video');

  if (!video) {
    setTimeout(attachToVideo, 500);
    return;
  }

  dubVideo = video; // the element we duck while a UA line is spoken

  // Listeners are attached exactly once even though this runs on every
  // translation/sync message, so we don't stack duplicate handlers.
  if (videoAttached) return;
  videoAttached = true;

  video.addEventListener('timeupdate', () => {
    if (!uaCues || !overlayEl || !settings.enabled) return;
    const w = findCueWindow(uaCues, video.currentTime);
    const sig = `${w.prev}|${w.cur}|${w.next}`;
    if (sig === lastWindowSig) return;
    lastWindowSig = sig;
    setSubtitleLevels(
      uaCues[w.prev]?.text,
      uaCues[w.cur]?.text,
      uaCues[w.next]?.text
    );
    // A new active cue → speak its voice-over (if we have the clip yet).
    maybeSpeak(w.cur, video.currentTime);
  });

  // Keep the dub glued to the video transport.
  video.addEventListener('pause', () => { if (dubAudio && !dubAudio.ended) dubAudio.pause(); });
  video.addEventListener('play', () => { if (dubAudio && dubAudio.src && !dubAudio.ended && dubAudio.paused) dubAudio.play().catch(() => {}); });
  video.addEventListener('seeking', () => { stopDub(); });
}

// ── Voice-over (dub) ──────────────────────────────────────────────────────────
// Each translated cue is synthesised to MP3 by the bridge and streamed here as
// base64 (via the service worker, to dodge mixed-content). We rebuild a blob,
// play it when its subtitle goes active, and duck the original audio under it.

const AUTO_MAX_RATE = 1.8; // hard cap for auto-fit so sped-up speech stays natural
const AUTO_FIT = 0.97;     // finish a touch before the window ends (avoids bleeding into the next line)
const DUCK_VOLUME = 0.12;  // original audio level while a UA line plays

const dubUrls = new Map(); // cueId → blob URL
let dubAudio = null;       // single reused <audio>
let dubVideo = null;       // the <video> we duck
let spokenId = null;       // cue currently voiced — guards against re-triggering
let origVolume = null;     // saved video volume, restored after ducking

function getDubAudio() {
  if (dubAudio) return dubAudio;
  dubAudio = new Audio();
  // Keep pitch natural when we speed the clip up — otherwise faster speech sounds
  // squeaky. Default is already true in modern Chrome; set it (and the legacy
  // prefixes) explicitly to be safe.
  dubAudio.preservesPitch = true;
  dubAudio.mozPreservesPitch = true;
  dubAudio.webkitPreservesPitch = true;
  dubAudio.addEventListener('ended', unduck);
  return dubAudio;
}

// Decide the playback tempo for a cue's clip.
//   'auto'  → fit the clip into its on-screen window (speed up only, capped).
//   number  → that exact multiplier, regardless of length.
// `duration` may be NaN before the clip's metadata has loaded; in auto mode we
// then fall back to 1× until loadedmetadata recomputes with the real length.
function computeRate(cue, duration) {
  if (settings.dubSpeed === 'auto') {
    if (!duration || !isFinite(duration)) return 1;
    const win = Math.max(0.5, cue.endSec - cue.startSec) * AUTO_FIT;
    return Math.min(AUTO_MAX_RATE, Math.max(1, duration / win));
  }
  const v = Number(settings.dubSpeed);
  return isFinite(v) && v > 0 ? Math.min(3, Math.max(0.5, v)) : 1;
}

// Re-apply the tempo to whatever clip is playing now (e.g. after the user
// changes the speed setting) — no re-synthesis needed, it's pure playbackRate.
function applyDubSpeed() {
  if (!dubAudio || !dubAudio.src || !spokenId || !uaCues) return;
  const cue = uaCues.find((c) => c.id === spokenId);
  if (cue) dubAudio.playbackRate = computeRate(cue, dubAudio.duration);
}

function duck() {
  if (!dubVideo) return;
  if (origVolume === null) origVolume = dubVideo.volume;
  dubVideo.volume = DUCK_VOLUME;
}

function unduck() {
  if (dubVideo && origVolume !== null) dubVideo.volume = origVolume;
  origVolume = null;
}

function base64ToBlobUrl(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
}

// Ask the bridge (via the worker) to synthesise the whole SRT for the chosen voice.
function requestDub() {
  if (!uaSRT || !settings.dub) return;
  clearDub();
  setDubBadge('Озвучення готується…');
  chrome.runtime.sendMessage({ type: 'REQUEST_TTS', srt: uaSRT, voice: settings.voice });
}

// Tear down all synthesised audio AND cancel any in-flight synthesis
// (voice change / disable / new video).
function clearDub() {
  try { chrome.runtime.sendMessage({ type: 'CANCEL_TTS' }); } catch {}
  stopDub();
  for (const url of dubUrls.values()) URL.revokeObjectURL(url);
  dubUrls.clear();
}

// Stop playback only (e.g. on seek) — keeps synthesised clips and the stream.
function stopDub() {
  if (dubAudio) dubAudio.pause(); // NB: never clear .src here — the browser throws a media error
  unduck();
  spokenId = null;
}

// Play cue `cueIdx`'s clip if it's synthesised and we're near its start.
function maybeSpeak(cueIdx, t) {
  if (!settings.dub || cueIdx < 0 || !uaCues) return;
  const cue = uaCues[cueIdx];
  if (!cue || cue.id === spokenId) return;
  const url = dubUrls.get(cue.id);
  if (!url) return;                    // not synthesised yet — retried on arrival/next tick
  if (t - cue.startSec > 1.5) return;  // scrubbed into the middle — don't blurt the whole line
  spokenId = cue.id;

  const a = getDubAudio();
  a.src = url;
  // Fixed speeds apply immediately; auto starts at 1× and refines once the
  // clip's real length is known.
  a.playbackRate = computeRate(cue, NaN);
  a.onloadedmetadata = () => { a.playbackRate = computeRate(cue, a.duration); };
  duck();
  a.play().then(() => setDubBadge('')).catch(() => {
    setDubBadge('Клікніть на сторінку, щоб увімкнути озвучення');
    unduck();
    spokenId = null; // allow a retry once the user interacts
  });
}

// ── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'TRANSLATION_START':
      ensureOverlay();
      setOverlayText('Перекладаємо… 0%', 'loading');
      break;

    case 'TRANSLATION_PROGRESS':
      setOverlayText(`Перекладаємо… ${msg.pct}%`, 'loading');
      break;

    case 'TRANSLATED_SRT':
      uaSRT = msg.srt;
      uaCues = parseSRT(msg.srt);
      console.log(`[ua-subs] Ready: ${uaCues.length} cues`);
      setSubtitleLevels('', '', '');
      suppressNativeCaptions();
      attachToVideo();
      requestDub();
      break;

    case 'TRANSLATION_ERROR':
      setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
      console.error('[ua-subs]', msg.error);
      break;

    case 'SETTINGS': {
      const voiceChanged = msg.voice !== undefined && msg.voice !== settings.voice;
      const dubChanged = msg.dub !== undefined && msg.dub !== settings.dub;
      if (msg.enabled !== undefined) settings.enabled = msg.enabled;
      if (msg.mode !== undefined) settings.mode = msg.mode;
      if (msg.layout !== undefined) settings.layout = msg.layout;
      if (msg.dub !== undefined) settings.dub = msg.dub;
      if (msg.voice !== undefined) settings.voice = msg.voice;
      // Speed is applied purely client-side (playbackRate) — no re-synthesis,
      // just retune the clip that's playing right now.
      if (msg.dubSpeed !== undefined) { settings.dubSpeed = msg.dubSpeed; applyDubSpeed(); }
      applySettings();
      // Turning dub on (or changing the voice while on) → (re)synthesise.
      if ((dubChanged && settings.dub) || (voiceChanged && settings.dub)) requestDub();
      // Turning dub off → stop and drop everything.
      else if (dubChanged && !settings.dub) { clearDub(); setDubBadge(''); }
      break;
    }

    // ── Voice-over stream from the worker ──────────────────────────────────────
    case 'TTS_CUE': {
      dubUrls.set(msg.id, base64ToBlobUrl(msg.audio));
      // If this clip belongs to the cue playing right now, speak it immediately
      // (it likely arrived after the window already switched to it).
      if (dubVideo && uaCues) {
        const w = findCueWindow(uaCues, dubVideo.currentTime);
        if (w.cur >= 0 && uaCues[w.cur]?.id === msg.id) maybeSpeak(w.cur, dubVideo.currentTime);
      }
      break;
    }

    case 'TTS_PROGRESS':
      if (settings.dub && msg.done < msg.total) {
        setDubBadge(`Озвучення… ${Math.round((msg.done / msg.total) * 100)}%`);
      }
      break;

    case 'TTS_DONE':
      setDubBadge('');
      console.log('[ua-subs] Dub ready');
      break;

    case 'TTS_ERROR':
      setDubBadge('Помилка озвучення');
      console.error('[ua-subs] TTS:', msg.error);
      break;
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(
  { enabled: true, mode: 'ua', layout: 'triple', dub: false, voice: 'uk-UA-OstapNeural', dubSpeed: 'auto' },
  (s) => {
    settings = s;
    applySettings();
  }
);

// Ask background for current translation state (handles race where .srt was
// requested before this content script was ready to receive messages)
chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (resp) => {
  if (chrome.runtime.lastError || !resp) return;
  if (resp.status === 'translating') {
    ensureOverlay();
    setOverlayText(`Перекладаємо… ${resp.pct}%`, 'loading');
  } else if (resp.status === 'done') {
    uaSRT = resp.srt;
    uaCues = parseSRT(resp.srt);
    console.log(`[ua-subs] Ready (synced): ${uaCues.length} cues`);
    ensureOverlay();
    setSubtitleLevels('', '', '');
    suppressNativeCaptions();
    attachToVideo();
    requestDub();
  } else if (resp.status === 'error') {
    ensureOverlay();
    setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
  }
});
