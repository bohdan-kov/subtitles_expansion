# Course Subtitles UA

Chrome extension that adds Ukrainian translated subtitles to online video courses.
Platform-agnostic: every supported site is described in a single registry, so
adding a new one is a one-file change.

Supported platforms (see `extension/sites.js`):
- **Skilljar** (e.g. Anthropic courses) — JW Player, `.srt` tracks
- **FrontendMasters** — Video.js, `.vtt` captions

## Requirements

- Node.js 18+
- Google Chrome
- An `OPENAI_API_KEY` (the local server translates via OpenAI `gpt-5-nano`)

## Installation

### 1. Start the local translation server

```bash
cd server
echo "OPENAI_API_KEY=sk-..." > .env
npm install
npm start
```

The server runs on `http://127.0.0.1:17382`.
Translated subtitles are cached in `~/.course-subs-ua/` — each video is only translated once.

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Watch a course

Open any lesson on a supported platform (e.g.
[anthropic.skilljar.com](https://anthropic.skilljar.com) or
[frontendmasters.com](https://frontendmasters.com)).
Ukrainian subtitles appear automatically when the video loads (~10s first time, instant from cache).

> **FrontendMasters note:** captions are fetched from `captions.frontendmasters.com`.
> If subtitles don't appear, enable **CC** in the player so the page requests the `.vtt` track.

## Adding another platform

Everything platform-specific lives in **one file** — `extension/sites.js`. To add a site:

1. Append an entry to `SUPPORTED_SITES` in `extension/sites.js`:
   ```js
   {
     id: 'udemy',
     label: 'Udemy',
     hostPermissions: ['*://*.udemy.com/*', '*://*.udemycdn.com/*'],
     pageMatches: ['*://*.udemy.com/*'],
     trackUrls: ['*://*.udemycdn.com/*.vtt'],   // the subtitle request to intercept
     player: ['.video-player'],                 // overlay container (survives fullscreen)
     video: ['video'],                          // the <video> element
   }
   ```
2. Regenerate the manifest from the registry:
   ```bash
   cd extension && node build-manifest.js
   ```
3. **Reload** the extension at `chrome://extensions` (a page refresh is not enough —
   manifest changes require a full extension reload).

The SRT/VTT parser on the server (`server/srt.js`) already handles both formats,
so most sites need no server changes.

## How it works

```
Browser intercepts the subtitle track request (.srt / .vtt)   ← urls from sites.js
  → background.js fetches the EN subtitle file
    → sends it to the local Node.js server (POST /translate)
      → server translates via OpenAI gpt-5-nano (terms preserved via glossary)
        → translated SRT returned (streamed) and cached by SHA256
          → content.js renders the Ukrainian overlay, synced to video.currentTime
```

## Troubleshooting

**"⚠ Сервер недоступний"** — start the server: `cd server && npm start`

**Subtitles don't appear** — open the extension's **service worker** console at
`chrome://extensions` and look for `[bg] Translating: …`. No line means the track
request wasn't intercepted (check `trackUrls` in `sites.js`); `Skipping non-English`
means the language heuristic rejected it.

**Translation quality** — edit `server/glossary.json` to add terms that should not be translated.

**Port conflict** — change port: `PORT=17400 npm start` and update the server URL in
`extension/background.js` and `extension/popup.js`.
