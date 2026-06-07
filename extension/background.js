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
            notify({ type: 'TRANSLATION_PROGRESS', pct });
          } else if (currentEvent === 'result') {
            state.done.add(url);
            state.inProgress.delete(url);
            state.status = 'done';
            state.srt = data.srt;
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
    console.error('[bg] Error:', err.message);
    notify({ type: 'TRANSLATION_ERROR', error: err.message });
  }
}

// ── Sync state to content script on init ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
  if (changeInfo.status === 'loading') tabState.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
