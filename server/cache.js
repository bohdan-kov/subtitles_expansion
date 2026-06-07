'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CACHE_DIR = path.join(os.homedir(), '.course-subs-ua');

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
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

module.exports = { readCache, writeCache, hashSRT };
