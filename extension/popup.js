'use strict';

const SERVER_HEALTH = 'http://127.0.0.1:17382/health';

const enabledToggle = document.getElementById('enabledToggle');
const modeSelect = document.getElementById('modeSelect');
const layoutSelect = document.getElementById('layoutSelect');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const jobsList = document.getElementById('jobsList');
const jobsEmpty = document.getElementById('jobsEmpty');
const clearJobsBtn = document.getElementById('clearJobs');

// ── Load saved settings ──────────────────────────────────────────────────────

chrome.storage.sync.get({ enabled: true, mode: 'ua', layout: 'triple' }, (settings) => {
  enabledToggle.checked = settings.enabled;
  modeSelect.value = settings.mode;
  layoutSelect.value = settings.layout;
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

layoutSelect.addEventListener('change', () => {
  const layout = layoutSelect.value;
  chrome.storage.sync.set({ layout });
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS', layout }).catch(() => {});
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

// ── Job progress list ────────────────────────────────────────────────────────
// Build each row once and patch it in place on every poll, so active downloads
// animate smoothly and scroll position / focus aren't reset.

const rendered = new Map(); // url → { root, name, sub, meta, bar }

function createJobNode() {
  const root = document.createElement('div');
  root.className = 'job';

  const top = document.createElement('div');
  top.className = 'job-top';
  const icon = document.createElement('span');
  icon.className = 'job-icon';
  const name = document.createElement('span');
  name.className = 'job-name';
  const meta = document.createElement('span');
  meta.className = 'job-meta';
  top.append(icon, name, meta);

  const sub = document.createElement('div');
  sub.className = 'job-sub';

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('i');
  bar.appendChild(fill);

  root.append(top, sub, bar);
  return { root, name, sub, meta, fill };
}

function metaText(job) {
  if (job.status === 'translating') return `${job.pct}%`;
  if (job.status === 'done') return job.cues ? `${job.cues} рядків` : 'Готово';
  return 'Помилка';
}

function subText(job) {
  if (job.status === 'error') return job.error || 'Не вдалося перекласти';
  return job.tabTitle || '—';
}

function renderJobs(list) {
  // Drop rows whose job no longer exists.
  const live = new Set(list.map((j) => j.url));
  for (const [url, node] of rendered) {
    if (!live.has(url)) {
      node.root.remove();
      rendered.delete(url);
    }
  }

  let hasFinished = false;
  for (const job of list) {
    if (job.status !== 'translating') hasFinished = true;

    let node = rendered.get(job.url);
    if (!node) {
      node = createJobNode();
      rendered.set(job.url, node);
      jobsList.appendChild(node.root);
    }

    if (node.root.dataset.status !== job.status) {
      node.root.className = `job ${job.status}`;
      node.root.dataset.status = job.status;
    }
    if (node.name.textContent !== job.name) node.name.textContent = job.name;
    node.name.title = job.name;

    const sub = subText(job);
    if (node.sub.textContent !== sub) node.sub.textContent = sub;

    const meta = metaText(job);
    if (node.meta.textContent !== meta) node.meta.textContent = meta;

    node.fill.style.width = `${job.pct}%`;
  }

  // Reconcile DOM order with the server's sort (active first), moving only the
  // rows actually out of place — re-appending unchanged nodes restarts their
  // CSS animation and makes the list jitter on every poll.
  let ref = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const node = rendered.get(list[i].url).root;
    if (node.nextSibling !== ref) jobsList.insertBefore(node, ref);
    ref = node;
  }

  jobsEmpty.style.display = list.length ? 'none' : '';
  clearJobsBtn.hidden = !hasFinished;
}

function pollJobs() {
  chrome.runtime.sendMessage({ type: 'GET_JOBS' }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    renderJobs(resp.jobs || []);
  });
}

clearJobsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_FINISHED_JOBS' }, pollJobs);
});

pollJobs();
setInterval(pollJobs, 800);
