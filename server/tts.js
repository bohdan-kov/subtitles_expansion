'use strict';

// ── Text-to-speech via Microsoft Edge neural voices (msedge-tts) ──────────────
//
// Free, key-less, and natural-sounding: we drive the same neural voices Edge
// uses for "Read aloud". For Ukrainian there are exactly two — Ostap (male) and
// Polina (female). Synthesis is streamed over a WebSocket; the expensive part is
// the handshake, so we keep a small pool of warm connections and reuse them
// across cues instead of reconnecting per line.

const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { readAudioCache, writeAudioCache, audioKey } = require('./cache');

// 24 kHz / 48 kbit mono MP3 — the sweet spot for speech: clean voice, small
// payload (we ship each cue to the browser as base64 over the SSE stream).
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

// Voices offered in the popup. `id` is the Edge ShortName; `label` is shown to
// the user. Keep the default first.
const VOICES = [
  { id: 'uk-UA-OstapNeural', label: 'Остап (чол.)', gender: 'male' },
  { id: 'uk-UA-PolinaNeural', label: 'Поліна (жін.)', gender: 'female' },
];
const DEFAULT_VOICE = VOICES[0].id;

function resolveVoice(voice) {
  return VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE;
}

// ── Transliteration of kept-English terms ─────────────────────────────────────
// The translator hands us a {term → Ukrainian reading} map. English terms stay
// Latin on screen (good for reading) but Edge's UA voices mispronounce them, so
// for *speech only* we swap each term for its Cyrillic reading.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull the kept-English terms out of translated cue texts: any run that contains
// a Latin letter (so "max_tokens", "gpt-5-nano", "Node.js", "C++" survive intact),
// with trailing sentence punctuation trimmed. Pure numbers are skipped. Used at
// dub time to decide which terms still need a reading from the dictionary.
function extractLatinTerms(texts) {
  const re = /[A-Za-z][A-Za-z0-9_+#.-]*/g;
  const out = [];
  for (const text of texts) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const term = m[0].replace(/[.\-]+$/, ''); // drop trailing dot/hyphen (e.g. "API.")
      if (term.length >= 2) out.push(term);
    }
  }
  return out;
}

// Compile the whole transliteration dictionary into a single replacer (built once per job, reused
// across all cues). Longest terms match first so "max_tokens" wins over "token";
// the boundaries treat letters, digits and `_` as word chars, so we never mangle
// a term sitting inside a snake_case identifier. Returns null when there's nothing
// to do, so callers can cheaply skip.
function buildTranslitReplacer(map) {
  const terms = map ? Object.keys(map).filter((t) => t && map[t]) : [];
  if (terms.length === 0) return null;
  terms.sort((a, b) => b.length - a.length);

  const lookup = new Map(terms.map((t) => [t.toLowerCase(), map[t]]));
  const alternation = terms.map(escapeRegExp).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, 'gi');

  return (text) => text.replace(re, (m) => lookup.get(m.toLowerCase()) ?? m);
}

// ── One warm connection ───────────────────────────────────────────────────────
// Wraps a single MsEdgeTTS instance pinned to one voice. Synthesis requests are
// run one at a time (the caller serialises via the pool). A dropped/idle socket
// surfaces as a stream error — we transparently reconnect and retry once.

class Synthesizer {
  constructor(voice) {
    this.voice = voice;
    this.tts = null;
  }

  async _ensure() {
    if (this.tts) return;
    const tts = new MsEdgeTTS();
    await tts.setMetadata(this.voice, FORMAT);
    this.tts = tts;
  }

  _reset() {
    try { this.tts?.close(); } catch {}
    this.tts = null;
  }

  _streamOnce(text, rate) {
    return new Promise((resolve, reject) => {
      // Pass prosody only when non-default so the SSML stays minimal. Edge's
      // neural voices already sound natural at their default rate; we expose
      // `rate` mainly so a cue can be nudged to fit its on-screen window.
      const opts = {};
      if (rate && rate !== 1) opts.rate = rate;

      const { audioStream } = this.tts.toStream(text, opts);
      const chunks = [];
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', reject);
    });
  }

  async synth(text, rate) {
    await this._ensure();
    try {
      return await this._streamOnce(text, rate);
    } catch (err) {
      // Stale or closed socket — rebuild the connection and try one more time.
      this._reset();
      await this._ensure();
      return await this._streamOnce(text, rate);
    }
  }

  close() { this._reset(); }
}

// ── Per-cue synthesis with a connection pool ──────────────────────────────────
//
// `synthesizeCues` walks the cue list with a bounded worker pool, emitting each
// finished cue's MP3 (as it lands) via `onCue`. Already-synthesised cues are
// served instantly from the on-disk audio cache, keyed by voice+text, so a
// repeat watch is silent network-wise.

const POOL_SIZE = 4;

async function synthesizeCues(cues, { voice, rate, translit, onCue, onProgress, isAborted } = {}) {
  const useVoice = resolveVoice(voice);
  const replacer = buildTranslitReplacer(translit);
  const workers = [];
  let next = 0;
  let done = 0;
  const total = cues.length;

  // Lazily create one Synthesizer per pool slot (reused across many cues).
  const pool = Array.from({ length: Math.min(POOL_SIZE, total) }, () => new Synthesizer(useVoice));

  async function runWorker(worker) {
    while (true) {
      if (isAborted?.()) return;
      const i = next++;
      if (i >= total) return;
      const cue = cues[i];

      // What the voice actually says: English terms swapped for their Ukrainian
      // reading. Falls back to the raw text when there's no dictionary. The audio
      // cache is keyed on this spoken text so a clip always matches its sound.
      const spoken = replacer ? replacer(cue.text) : cue.text;

      let mp3;
      const key = audioKey(useVoice, spoken);
      const cached = readAudioCache(key);
      if (cached) {
        mp3 = cached;
      } else {
        try {
          mp3 = await worker.synth(spoken, rate);
          writeAudioCache(key, mp3);
        } catch (err) {
          // One bad cue shouldn't sink the whole dub — skip it and carry on.
          console.error(`[tts] cue ${cue.id} failed: ${err.message}`);
          done++;
          onProgress?.(done, total);
          continue;
        }
      }

      if (isAborted?.()) return;
      onCue?.({ id: cue.id, startSec: cue.startSec, endSec: cue.endSec, mp3 });
      done++;
      onProgress?.(done, total);
    }
  }

  try {
    await Promise.all(pool.map((w) => runWorker(w)));
  } finally {
    for (const w of pool) w.close();
  }
}

module.exports = { synthesizeCues, extractLatinTerms, VOICES, DEFAULT_VOICE, resolveVoice };
