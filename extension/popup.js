'use strict';

const SERVER_HEALTH = 'http://127.0.0.1:17382/health';

const enabledToggle = document.getElementById('enabledToggle');
const modeSelect = document.getElementById('modeSelect');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

// ── Load saved settings ──────────────────────────────────────────────────────

chrome.storage.sync.get({ enabled: true, mode: 'ua' }, (settings) => {
  enabledToggle.checked = settings.enabled;
  modeSelect.value = settings.mode;
});

// ── Save on change ───────────────────────────────────────────────────────────

enabledToggle.addEventListener('change', () => {
  const enabled = enabledToggle.checked;
  chrome.storage.sync.set({ enabled });
  // Notify active tab
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS', enabled }).catch(() => {});
    }
  });
});

modeSelect.addEventListener('change', () => {
  const mode = modeSelect.value;
  chrome.storage.sync.set({ mode });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS', mode }).catch(() => {});
    }
  });
});

// ── Server health check ──────────────────────────────────────────────────────

async function checkServer() {
  try {
    const resp = await fetch(SERVER_HEALTH, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      statusDot.className = 'status-dot ok';
      statusText.textContent = 'онлайн';
    } else {
      throw new Error(resp.statusText);
    }
  } catch {
    statusDot.className = 'status-dot error';
    statusText.textContent = 'недоступний';
  }
}

checkServer();
