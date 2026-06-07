'use strict';

const OVERLAY_ID = 'ua-subs-overlay';

// Resolved from the shared registry (sites.js is injected before this script).
// Holds the player/video selectors for whichever platform we're on.
const SITE = siteForUrl(location.href);

let uaCues = null;       // Array<{id, startSec, endSec, text}>
let overlayEl = null;
let lastCueId = null;
let settings = { enabled: true, mode: 'ua' };

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

// ── Active cue lookup (binary search) ───────────────────────────────────────

function findActiveCue(cues, t) {
  let lo = 0, hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].endSec < t) lo = mid + 1;
    else if (cues[mid].startSec > t) hi = mid - 1;
    else return cues[mid];
  }
  return null;
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

  const textEl = document.createElement('span');
  textEl.className = 'ua-subs-text';
  overlayEl.appendChild(textEl);

  container.appendChild(overlayEl);
  applySettings();
  return overlayEl;
}

function setOverlayText(text, mode = 'subtitle') {
  const el = ensureOverlay();
  if (!el) return;
  el.dataset.mode = mode;
  el.querySelector('.ua-subs-text').textContent = text;
}

function applySettings() {
  if (!overlayEl) return;
  overlayEl.style.display = settings.enabled ? '' : 'none';
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
    const cue = findActiveCue(uaCues, video.currentTime);
    const id = cue?.id ?? null;
    if (id === lastCueId) return;
    lastCueId = id;
    setOverlayText(cue?.text ?? '', 'subtitle');
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
      setOverlayText('', 'subtitle');
      attachToVideo();
      break;

    case 'TRANSLATION_ERROR':
      setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
      console.error('[ua-subs]', msg.error);
      break;

    case 'SETTINGS':
      if (msg.enabled !== undefined) settings.enabled = msg.enabled;
      if (msg.mode !== undefined) settings.mode = msg.mode;
      applySettings();
      break;
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────

chrome.storage.sync.get({ enabled: true, mode: 'ua' }, (s) => { settings = s; });

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
    setOverlayText('', 'subtitle');
    attachToVideo();
  } else if (resp.status === 'error') {
    ensureOverlay();
    setOverlayText('⚠ Сервер недоступний — запустіть: cd server && npm start', 'error');
  }
});
