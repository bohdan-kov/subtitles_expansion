'use strict';

const express = require('express');
const cors = require('cors');
const { parseSRT, serializeSRT } = require('./srt');
const { translateAll } = require('./translator');
const { readCache, writeCache } = require('./cache');
const { synthesizeCues, VOICES } = require('./tts');

const PORT = process.env.PORT || 17382;
const app = express();

// In-flight lock: hash → Promise<string>
// If the same SRT arrives while translation is in progress, the second request
// waits for the first one instead of starting a duplicate translation job.
const inFlight = new Map();

// Chrome Private Network Access headers must come BEFORE cors() middleware
// so they are included in OPTIONS preflight responses too.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.options('*', (_req, res) => res.sendStatus(204));

app.use(cors({ origin: '*' }));

app.use(express.text({ type: '*/*', limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

// List of available dubbing voices (drives the popup's voice picker).
app.get('/voices', (_req, res) => {
  res.json({ voices: VOICES });
});

// Convert an SRT timestamp ("00:01:02,500") to seconds.
function tsToSeconds(ts) {
  const [h, m, rest] = ts.split(':');
  const [s, ms] = rest.replace('.', ',').split(',');
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}

// ── POST /tts — synthesise Ukrainian voice-over for an (already translated) SRT ─
// Body: the UA SRT text. Query: ?voice=<ShortName>&rate=<0.5..2>.
// Streams Server-Sent Events: `meta` (total cues) → many `cue` (base64 MP3 +
// timing) → `progress` → `done`. The browser plays each clip in sync with its
// subtitle and ducks the original audio underneath.
app.post('/tts', async (req, res) => {
  const rawSRT = req.body;
  if (!rawSRT || typeof rawSRT !== 'string' || rawSRT.trim().length === 0) {
    return res.status(400).json({ error: 'Request body must be a non-empty SRT string' });
  }

  const voice = req.query.voice;
  const rate = req.query.rate ? Number(req.query.rate) : 1;

  let cues;
  try {
    cues = parseSRT(rawSRT).map((c) => ({
      id: c.id,
      text: c.text.replace(/\s*\n\s*/g, ' ').trim(), // flatten multi-line cues for speech
      startSec: tsToSeconds(c.start),
      endSec: tsToSeconds(c.end),
    }));
  } catch (err) {
    return res.status(400).json({ error: `SRT parse error: ${err.message}` });
  }
  if (cues.length === 0) {
    return res.status(400).json({ error: 'No valid cues found in SRT' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Abort detection: watch the *response* socket and only treat a close as an
  // abort if the response hasn't finished normally. (Watching `req` is wrong for
  // a POST whose body is already buffered — it emits 'close' immediately and
  // would falsely abort the job before it starts.)
  let aborted = false;
  res.on('close', () => { if (!res.writableFinished) aborted = true; });

  console.log(`[tts] POST /tts — ${cues.length} cues, voice=${voice || 'default'}`);
  send('meta', { total: cues.length, voice: voice || 'default' });

  try {
    await synthesizeCues(cues, {
      voice,
      rate,
      isAborted: () => aborted,
      onCue: ({ id, startSec, endSec, mp3 }) => {
        send('cue', { id, startSec, endSec, audio: mp3.toString('base64') });
      },
      onProgress: (done, total) => send('progress', { done, total }),
    });
    if (!aborted) send('done', { ok: true });
  } catch (err) {
    console.error(`[tts] failed: ${err.message}`);
    if (!aborted) send('error', { error: err.message });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

app.post('/translate', async (req, res) => {
  const rawSRT = req.body;

  if (!rawSRT || typeof rawSRT !== 'string' || rawSRT.trim().length === 0) {
    return res.status(400).json({ error: 'Request body must be a non-empty SRT string' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // 1. Cache hit
  const cached = readCache(rawSRT);
  if (cached) {
    send('result', { srt: cached });
    return res.end();
  }

  // 2. Already translating this exact SRT — wait for the in-flight job
  const { hashSRT } = require('./cache');
  const hash = hashSRT(rawSRT);
  if (inFlight.has(hash)) {
    console.log(`[server] Waiting for in-flight translation (${hash.slice(0, 8)}…)`);
    try {
      const result = await inFlight.get(hash);
      send('result', { srt: result });
      return res.end();
    } catch (err) {
      send('error', { error: err.message });
      return res.end();
    }
  }

  // 3. Start a new translation job
  let cues;
  try {
    cues = parseSRT(rawSRT);
  } catch (err) {
    send('error', { error: `SRT parse error: ${err.message}` });
    return res.end();
  }

  if (cues.length === 0) {
    send('error', { error: 'No valid cues found in SRT' });
    return res.end();
  }

  console.log(`[server] POST /translate — ${cues.length} cues, MISS`);

  const onProgress = (done, total) => send('progress', { done, total });

  const job = translateAll(cues, onProgress)
    .then((translatedCues) => {
      const translatedSRT = serializeSRT(translatedCues);
      writeCache(rawSRT, translatedSRT);
      return translatedSRT;
    })
    .finally(() => inFlight.delete(hash));

  inFlight.set(hash, job);

  try {
    const translatedSRT = await job;
    send('result', { srt: translatedSRT });
    res.end();
  } catch (err) {
    console.error(`[server] Translation failed: ${err.message}`);
    send('error', { error: err.message });
    res.end();
  }
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[server] Test: curl -X POST --data-binary @../subtitle.txt http://127.0.0.1:${PORT}/translate`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] Port ${PORT} is already in use. Run: lsof -ti:${PORT} | xargs kill -9`);
    process.exit(1);
  } else {
    throw err;
  }
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
