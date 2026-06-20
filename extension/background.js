'use strict';

// Load the shared site registry (SUPPORTED_SITES, allTrackUrls, …) into the
// service worker's global scope.
importScripts('sites.js');

// Per-tab state: avoid re-translating the same URL
// tabId → { inProgress: Set<url>, done: Set<url>, status, pct, srt, error }
const tabState = new Map();

function getState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      inProgress: new Set(),
      done: new Set(),
      status: 'idle', // 'idle' | 'translating' | 'done' | 'error'
      pct: 0,
      srt: null,
      error: null,
    });
  }
  return tabState.get(tabId);
}

// ── Per-video job registry (drives the popup's progress list) ─────────────────
// Keyed by track URL so each intercepted subtitle file is one independent job.
// jobs: url → { url, name, tabId, tabTitle, status, pct, error, cues, startedAt, updatedAt }
const jobs = new Map();

// Derive a friendly label from a track URL (decoded filename, sans extension).
function jobName(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.(srt|vtt)$/i, '') || url;
  } catch {
    return url;
  }
}

// Best-effort page title for context in the list (which course/lesson the
// subtitle belongs to). Resolves to '' if the tab is gone.
function getTabTitle(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        resolve(chrome.runtime.lastError ? '' : tab?.title || '');
      });
    } catch {
      resolve('');
    }
  });
}

// Create or update a job, stamping updatedAt so the popup can sort by recency.
function upsertJob(url, patch) {
  const prev = jobs.get(url) || {
    url,
    name: jobName(url),
    tabId: null,
    tabTitle: '',
    status: 'translating',
    pct: 0,
    error: null,
    cues: 0,
    startedAt: Date.now(),
  };
  const job = { ...prev, ...patch, updatedAt: Date.now() };
  jobs.set(url, job);
  return job;
}

// Active jobs float to the top, then errors, then finished — recent first within
// each group.
function jobSort(a, b) {
  const rank = (s) => (s === 'translating' ? 0 : s === 'error' ? 1 : 2);
  return rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt;
}

function deleteTabJobs(tabId) {
  for (const [url, job] of jobs) {
    if (job.tabId === tabId) jobs.delete(url);
  }
}

// Reflect a tab's translation state on the toolbar icon with a compact badge:
//   N  (orange) — N active translations · ✓ (green) — finished · ! (red) — error
// Per-tab so each course tab shows only its own state; no badge when idle.
function refreshBadge(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  let active = 0, done = 0, error = 0;
  for (const job of jobs.values()) {
    if (job.tabId !== tabId) continue;
    if (job.status === 'translating') active++;
    else if (job.status === 'error') error++;
    else if (job.status === 'done') done++;
  }

  let text = '', color = '#c04a00';
  if (active > 0) text = String(active);
  else if (error > 0) { text = '!'; color = '#e74c3c'; }
  else if (done > 0) { text = '✓'; color = '#27ae60'; }

  try {
    chrome.action.setBadgeText({ tabId, text });
    if (text) {
      chrome.action.setBadgeBackgroundColor({ tabId, color });
      chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
    }
  } catch {}
}

// ── English detection (same heuristic as before) ─────────────────────────────

function looksEnglish(rawSRT) {
  // Strip subtitle scaffolding (WEBVTT header, cue numbers, timestamps, tags)
  // so the heuristic sees real spoken text, not formatting — VTT files front-load
  // a lot of timecodes that would otherwise crowd out the sampled words.
  const textOnly = rawSRT
    .replace(/^WEBVTT[^\n]*/i, '')
    .replace(/\d{1,2}:\d{2}:\d{2}[,\.]\d{3}\s*-->.*$/gm, '') // timestamp lines
    .replace(/^\s*\d+\s*$/gm, '')                            // bare cue-number lines
    .replace(/<[^>]+>/g, '')                                 // inline tags
    .toLowerCase();

  const sample = textOnly.slice(0, 2000);
  const hits = [
    ' the ', ' is ', ' are ', ' we ', ' to ', ' of ', ' in ', ' and ',
    ' you ', ' that ', ' it ', " i'm ", ' this ', ' for ', ' on ', ' so ',
  ].filter((w) => sample.includes(w));
  return hits.length >= 3;
}

// ── Core: fetch SRT + translate + notify content script ──────────────────────

async function processURL(tabId, url) {
  const state = getState(tabId);

  // Skip if already done or currently translating this URL
  if (state.done.has(url) || state.inProgress.has(url)) return;
  state.inProgress.add(url);

  const notify = (msg) =>
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});

  try {
    // 1. Fetch the SRT — background workers bypass CORS/mixed-content restrictions
    const srtResp = await fetch(url);
    if (!srtResp.ok) throw new Error(`SRT fetch ${srtResp.status}`);
    const rawSRT = await srtResp.text();

    // 2. Skip non-English tracks
    if (!looksEnglish(rawSRT)) {
      console.log('[bg] Skipping non-English:', url);
      state.inProgress.delete(url);
      return;
    }

    console.log('[bg] Translating:', url);
    state.status = 'translating';
    state.pct = 0;
    upsertJob(url, {
      tabId,
      tabTitle: await getTabTitle(tabId),
      status: 'translating',
      pct: 0,
      error: null,
      startedAt: Date.now(),
    });
    refreshBadge(tabId);
    notify({ type: 'TRANSLATION_START' });

    // 3. Send to local translation server (SSE stream)
    const transResp = await fetch('http://127.0.0.1:17382/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: rawSRT,
    });

    if (!transResp.ok) {
      const err = await transResp.json().catch(() => ({ error: transResp.statusText }));
      throw new Error(err.error || transResp.statusText);
    }

    const reader = transResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'progress') {
            const pct = Math.round(data.done / data.total * 100);
            state.pct = pct;
            upsertJob(url, { status: 'translating', pct });
            notify({ type: 'TRANSLATION_PROGRESS', pct });
          } else if (currentEvent === 'result') {
            state.done.add(url);
            state.inProgress.delete(url);
            state.status = 'done';
            state.srt = data.srt;
            upsertJob(url, {
              status: 'done',
              pct: 100,
              cues: (data.srt.match(/-->/g) || []).length,
            });
            refreshBadge(tabId);
            notify({ type: 'TRANSLATED_SRT', srt: data.srt });
            console.log('[bg] Done:', url);
            return;
          } else if (currentEvent === 'error') {
            throw new Error(data.error);
          }
          currentEvent = null;
        }
      }
    }

  } catch (err) {
    state.inProgress.delete(url);
    state.status = 'error';
    state.error = err.message;
    // Only surface a job entry if we'd already committed to translating this
    // track — a fetch/skip failure before that shouldn't litter the list.
    if (jobs.has(url)) {
      upsertJob(url, { status: 'error', error: err.message });
      refreshBadge(tabId);
    }
    console.error('[bg] Error:', err.message);
    notify({ type: 'TRANSLATION_ERROR', error: err.message });
  }
}

// ── Voice-over (TTS) streaming proxy ──────────────────────────────────────────
// The page is https, the bridge is http://127.0.0.1 — fetching it from a content
// script trips mixed-content. So the service worker does the fetch and relays
// each synthesised cue (base64 MP3) to the content script, which rebuilds it
// into a blob and plays it in sync. One in-flight job per tab; a new request
// (e.g. voice change) aborts the previous one.
const ttsAbort = new Map(); // tabId → AbortController

async function streamTTS(tabId, srt, voice) {
  ttsAbort.get(tabId)?.abort();
  const ctrl = new AbortController();
  ttsAbort.set(tabId, ctrl);

  const notify = (msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => {});

  try {
    const url = `http://127.0.0.1:17382/tts?voice=${encodeURIComponent(voice || '')}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: srt,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error || resp.statusText);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          if (currentEvent === 'meta') {
            notify({ type: 'TTS_META', total: data.total });
          } else if (currentEvent === 'cue') {
            notify({ type: 'TTS_CUE', id: data.id, startSec: data.startSec, endSec: data.endSec, audio: data.audio });
          } else if (currentEvent === 'progress') {
            notify({ type: 'TTS_PROGRESS', done: data.done, total: data.total });
          } else if (currentEvent === 'done') {
            notify({ type: 'TTS_DONE' });
          } else if (currentEvent === 'error') {
            throw new Error(data.error);
          }
          currentEvent = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return; // superseded by a newer request — silent
    console.error('[bg] TTS error:', err.message);
    notify({ type: 'TTS_ERROR', error: err.message });
  } finally {
    if (ttsAbort.get(tabId) === ctrl) ttsAbort.delete(tabId);
  }
}

// ── Sync state to content script on init ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Content script asks to synthesise voice-over for the (translated) SRT.
  if (msg.type === 'REQUEST_TTS') {
    const tabId = sender.tab?.id;
    if (tabId) streamTTS(tabId, msg.srt, msg.voice);
    return false;
  }
  // Content script asks to cancel an in-flight voice-over (dub turned off).
  if (msg.type === 'CANCEL_TTS') {
    const tabId = sender.tab?.id;
    if (tabId) { ttsAbort.get(tabId)?.abort(); ttsAbort.delete(tabId); }
    return false;
  }
  // Popup: fetch the live job list for the progress view.
  if (msg.type === 'GET_JOBS') {
    sendResponse({ jobs: [...jobs.values()].sort(jobSort) });
    return false;
  }
  // Popup: drop finished/errored jobs, keep anything still translating.
  if (msg.type === 'CLEAR_FINISHED_JOBS') {
    const affected = new Set();
    for (const [url, job] of jobs) {
      if (job.status !== 'translating') {
        affected.add(job.tabId);
        jobs.delete(url);
      }
    }
    affected.forEach(refreshBadge);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type !== 'CONTENT_READY') return false;
  const tabId = sender.tab?.id;
  if (!tabId) return false;
  const state = tabState.get(tabId);
  if (!state || state.status === 'idle') {
    sendResponse({ status: 'idle' });
  } else if (state.status === 'translating') {
    sendResponse({ status: 'translating', pct: state.pct });
  } else if (state.status === 'done') {
    sendResponse({ status: 'done', srt: state.srt });
  } else if (state.status === 'error') {
    sendResponse({ status: 'error', error: state.error });
  }
  return false;
});

// ── Intercept .srt requests ───────────────────────────────────────────────────

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    processURL(details.tabId, details.url);
  },
  // Track-URL patterns are derived from the site registry (sites.js).
  { urls: allTrackUrls() }
);

// ── Cleanup on navigation / tab close ────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    tabState.delete(tabId);
    // Cancel any voice-over still streaming for the old page.
    ttsAbort.get(tabId)?.abort();
    ttsAbort.delete(tabId);
    // Keep in-flight translations — they continue in the background across
    // navigation, so dropping them here would hide a download that's still
    // running. Only clear this tab's already-finished/errored jobs.
    for (const [url, job] of jobs) {
      if (job.tabId === tabId && job.status !== 'translating') jobs.delete(url);
    }
    refreshBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  deleteTabJobs(tabId);
  ttsAbort.get(tabId)?.abort();
  ttsAbort.delete(tabId);
});
