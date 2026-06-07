'use strict';

/**
 * Generates manifest.json from the single source of truth in sites.js.
 *
 * Run after editing sites.js:
 *   node build-manifest.js
 *
 * host_permissions and content_scripts.matches are derived from the registry,
 * so adding a platform never means hand-editing the manifest.
 */

const fs = require('fs');
const path = require('path');
const { SUPPORTED_SITES } = require('./sites');

const unique = (arr) => [...new Set(arr)];

const manifest = {
  manifest_version: 3,
  name: 'Course Subtitles UA',
  version: '0.4.0',
  description: 'Ukrainian translation subtitles for online video courses',

  permissions: ['storage', 'webRequest'],

  host_permissions: unique(SUPPORTED_SITES.flatMap((s) => s.hostPermissions)),

  background: {
    service_worker: 'background.js',
  },

  content_scripts: [
    {
      matches: unique(SUPPORTED_SITES.flatMap((s) => s.pageMatches)),
      js: ['sites.js', 'content.js'],
      css: ['content.css'],
      run_at: 'document_idle',
    },
  ],

  action: {
    default_popup: 'popup.html',
    default_title: 'Course Subtitles UA',
  },
};

const out = path.join(__dirname, 'manifest.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');

console.log(`Wrote ${path.relative(process.cwd(), out)} from ${SUPPORTED_SITES.length} site(s):`);
for (const s of SUPPORTED_SITES) console.log(`  • ${s.id} — ${s.label}`);
