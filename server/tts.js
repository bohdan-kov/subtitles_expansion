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

async function synthesizeCues(cues, { voice, rate, onCue, onProgress, isAborted } = {}) {
  const useVoice = resolveVoice(voice);
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

      let mp3;
      const key = audioKey(useVoice, cue.text);
      const cached = readAudioCache(key);
      if (cached) {
        mp3 = cached;
      } else {
        try {
          mp3 = await worker.synth(cue.text, rate);
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

module.exports = { synthesizeCues, VOICES, DEFAULT_VOICE, resolveVoice };
