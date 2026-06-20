'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CACHE_DIR = path.join(os.homedir(), '.course-subs-ua');
// Synthesised speech lives in a sub-folder so it doesn't mingle with .srt files.
const AUDIO_DIR = path.join(CACHE_DIR, 'audio');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function ensureAudioDir() {
  if (!fs.existsSync(AUDIO_DIR)) {
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
  }
}

function hashSRT(rawSRT) {
  return crypto.createHash('sha256').update(rawSRT).digest('hex');
}

function cachePath(hash) {
  return path.join(CACHE_DIR, `${hash}.srt`);
}

function readCache(rawSRT) {
  ensureCacheDir();
  const file = cachePath(hashSRT(rawSRT));
  if (fs.existsSync(file)) {
    console.log(`[cache] HIT ${path.basename(file)}`);
    return fs.readFileSync(file, 'utf8');
  }
  return null;
}

function writeCache(rawSRT, translatedSRT) {
  ensureCacheDir();
  const file = cachePath(hashSRT(rawSRT));
  fs.writeFileSync(file, translatedSRT, 'utf8');
  console.log(`[cache] WRITE ${path.basename(file)}`);
}

// ── Persistent transliteration dictionary ─────────────────────────────────────
// One global, ever-growing {lowercased term → Ukrainian reading} map shared
// across every video. Kept-English terms recur constantly (API, token, prompt…),
// so once a term is transliterated we never pay GPT for it again. It lives as a
// visible file in the project (`server/translit-dict.json`), not the hidden
// cache dir, so you can open it and hand-tune any reading — edits stick.

const TRANSLIT_DICT_FILE = path.join(__dirname, 'translit-dict.json');

function readTranslitDict() {
  if (!fs.existsSync(TRANSLIT_DICT_FILE)) return {};
  try {
    const map = JSON.parse(fs.readFileSync(TRANSLIT_DICT_FILE, 'utf8'));
    return (map && typeof map === 'object' && !Array.isArray(map)) ? map : {};
  } catch {
    return {}; // corrupt dict — start fresh rather than break dubbing
  }
}

function writeTranslitDict(map) {
  // Sorted keys keep the file diff-friendly and easy to scan when hand-editing.
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.writeFileSync(TRANSLIT_DICT_FILE, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`[cache] WRITE translit-dict.json (${Object.keys(sorted).length} terms)`);
}

// ── Audio (TTS) cache ─────────────────────────────────────────────────────────
// One MP3 per (voice, text) pair — voice changes the timbre, text changes the
// words; speaking rate is applied on the client (playbackRate), so it stays out
// of the key and a cached clip is reused regardless of tempo.

function audioKey(voice, text) {
  return crypto.createHash('sha256').update(`${voice}\n${text}`).digest('hex');
}

function audioPath(key) {
  return path.join(AUDIO_DIR, `${key}.mp3`);
}

function readAudioCache(key) {
  ensureAudioDir();
  const file = audioPath(key);
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function writeAudioCache(key, buffer) {
  ensureAudioDir();
  fs.writeFileSync(audioPath(key), buffer);
}

module.exports = {
  readCache, writeCache, hashSRT,
  readTranslitDict, writeTranslitDict,
  readAudioCache, writeAudioCache, audioKey,
};
