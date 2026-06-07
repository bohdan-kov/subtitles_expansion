'use strict';

const express = require('express');
const cors = require('cors');
const { parseSRT, serializeSRT } = require('./srt');
const { translateAll } = require('./translator');
const { readCache, writeCache } = require('./cache');

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
