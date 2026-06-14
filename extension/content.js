'use strict';

const OVERLAY_ID = 'ua-subs-overlay';

// Resolved from the shared registry (sites.js is injected before this script).
// Holds the player/video selectors for whichever platform we're on.
const SITE = siteForUrl(location.href);

let uaCues = null;       // Array<{id, startSec, endSec, text}>
let overlayEl = null;
let lastWindowSig = null; // signature of the last rendered prev|cur|next window
let settings = { enabled: true, mode: 'ua', layout: 'triple' };

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

function attachToVideo() {
  const video = firstMatch(SITE?.video) || document.querySelector('video');

  if (!video) {
    setTimeout(attachToVideo, 500);
    return;
  }

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
      uaCues = parseSRT(msg.srt);
      console.log(`[ua-subs] Ready: ${uaCues.length} cues`);
      setSubtitleLevels('', '', '');
      suppressNativeCaptions();
      attachToVideo();
      break;

    case 'TRANSLATION_ERROR':
      setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
      console.error('[ua-subs]', msg.error);
      break;

    case 'SETTINGS':
      if (msg.enabled !== undefined) settings.enabled = msg.enabled;
      if (msg.mode !== undefined) settings.mode = msg.mode;
      if (msg.layout !== undefined) settings.layout = msg.layout;
      applySettings();
      break;
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get({ enabled: true, mode: 'ua', layout: 'triple' }, (s) => {
  settings = s;
  applySettings();
});

// Ask background for current translation state (handles race where .srt was
// requested before this content script was ready to receive messages)
chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (resp) => {
  if (chrome.runtime.lastError || !resp) return;
  if (resp.status === 'translating') {
    ensureOverlay();
    setOverlayText(`Перекладаємо… ${resp.pct}%`, 'loading');
  } else if (resp.status === 'done') {
    uaCues = parseSRT(resp.srt);
    console.log(`[ua-subs] Ready (synced): ${uaCues.length} cues`);
    ensureOverlay();
    setSubtitleLevels('', '', '');
    suppressNativeCaptions();
    attachToVideo();
  } else if (resp.status === 'error') {
    ensureOverlay();
    setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
  }
});
