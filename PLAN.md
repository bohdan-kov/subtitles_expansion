# План розробки: Anthropic Courses UA Subtitles

## Контекст

Розширення для Chrome, що додає українські субтитри до відеокурсів Anthropic
(платформа Skilljar, плеєр JW Player). Оригінальні англійські субтитри
перехоплюються на льоту, надсилаються на локальний міст, який викликає **Groq API**
(`llama-3.3-70b-versatile`) для перекладу (технічні терміни залишаються англійською), і
повертаються у вигляді нового SRT. Розширення відмальовує переклад у власному
оверлеї поверх відео, синхронізовано з `currentTime`.

**Проблема:** курси Anthropic українською не доступні; дивитись англійською
важко через щільну термінологію. Готові перекладачі (Google Translate тощо)
ламають технічні терміни.

**Очікуваний результат:** зайшов на урок → через ~5 секунд (або миттєво з кешу)
бачиш якісні українські субтитри з коректно збереженими термінами `API`,
`tokens`, `embeddings`, `max_tokens`, `SDK` тощо.

---

## Архітектурне рішення

```
┌─────────────────────────────┐       ┌──────────────────────────────┐
│  Chrome Extension (MV3)     │       │  Локальний Node.js сервер    │
│                             │       │  (localhost:17382)           │
│  ├─ content.js              │◄─────►│                              │
│  │   перехоплення .srt,     │ HTTP  │  POST /translate             │
│  │   рендер оверлея,        │       │    ├─ SHA256(srt) → кеш?     │
│  │   синхронізація з video  │       │    ├─ split якщо > 10k TPM   │
│  │                          │       │    ├─ Groq API call          │
│  ├─ background.js           │       │    │  (llama-3.3-70b)        │
│  │   webRequest listener    │       │    └─ збірка UA .srt         │
│  │                          │       │                              │
│  ├─ popup.html + popup.js   │       │  GET /health                 │
│  │   налаштування           │       │                              │
│  │                          │       │  Кеш: ~/.anthropic-ua-subs/  │
│  └─ manifest.json           │       │    └─ <sha256>.srt           │
└─────────────────────────────┘       └──────────────────────────────┘
                                             │
                                             ▼
                                      Groq API (cloud)
                                      llama-3.3-70b-versatile
                                      Free tier: 12 000 TPM
```

**Чому Groq замість claude CLI:** набагато швидше (~2–3с на весь SRT),
безкоштовний free tier, не потребує встановленого Claude Code CLI.
Ключ зберігається у `server/.env`.

**Чому HTTP-сервер, а не Native Messaging:** простіше дебажити, не треба
реєструвати маніфест у системі, можна запустити з терміналу і бачити логи.

---

## Структура репозиторію

```
subtitles_expansion/
├── extension/
│   ├── sites.js               # ★ ЄДИНИЙ РЕЄСТР сайтів (домени, треки, селектори)
│   ├── build-manifest.js      # генерує manifest.json з sites.js
│   ├── manifest.json          # згенерований — НЕ редагувати вручну
│   ├── background.js          # webRequest (фільтр із sites.js), зв'язок з сервером
│   ├── content.js             # перехоплення, рендер, синхронізація (селектори з sites.js)
│   ├── content.css            # стилі оверлея
│   ├── popup.html             # налаштування (on/off, режим)
│   ├── popup.js
│   └── icons/                 # 16, 48, 128
├── server/
│   ├── package.json
│   ├── .env                   # GROQ_API_KEY
│   ├── index.js               # Express-сервер
│   ├── translator.js          # Groq API виклик, splitting, ретраї
│   ├── srt.js                 # парсер/серіалізатор SRT
│   ├── cache.js               # файловий кеш SHA256
│   └── glossary.json          # словник термінів-винятків (preserveAsIs)
├── README.md
├── PLAN.md                    # цей файл
└── subtitle.txt               # приклад SRT з реального курсу
```

---

## Етап 1 — MVP (валідація концепції) ✅

**Мета:** довести, що Groq API адекватно перекладає SRT із збереженням
тайм-кодів і термінології. Без UI, без розширення, без кешу.

- [x] `server/package.json` з залежностями (express, cors, groq-sdk, dotenv).
- [x] `server/srt.js` — парсер SRT у масив `{id, start, end, text}` і назад.
- [x] `server/translator.js` — функція `translateAll(cues[]) → cues[]`:
  - формує системний промпт із глосарієм (терміни зі списку `preserveAsIs`
    залишаються англійськими);
  - якщо SRT > ~10 000 токенів — ділить на 2 половини і перекладає паралельно;
  - `client.chat.completions.create(model: 'llama-3.3-70b-versatile', ...)`;
  - парсить JSON-відповідь, повертає оновлені `cues`; 3 ретраї на спроби.
- [x] `server/index.js` — `POST /translate` приймає сирий SRT у body,
  повертає перекладений SRT; `GET /health` для ping.
- [x] Ручний тест через `curl`: `subtitle.txt` → UA SRT за ~3с.

---

## Етап 2 — Chrome-розширення: перехоплення та рендер ✅

**Мета:** кінець-в-кінець працює в браузері на одному курсі.

- [x] `manifest.json` (MV3): permissions `webRequest`, `storage`,
  `host_permissions` для `*://anthropic.skilljar.com/*` та
  `*://assets-jpcust.jwpsrv.com/*`.
- [x] `background.js`: слухає `chrome.webRequest.onBeforeRequest` з патерном
  `*://assets-jpcust.jwpsrv.com/tracks/*.srt`, шле URL у content script
  через `chrome.tabs.sendMessage`.
- [x] `content.js`:
  - `fetch(srtUrl)` → сирий текст;
  - `fetch('http://127.0.0.1:17382/translate', { method:'POST', body:srt })`;
  - створює `<div id="ua-subs-overlay">` всередині `.jwplayer`;
  - на `timeupdate` знаходить активну репліку, оновлює текст.
- [x] `content.css`: позиціонування знизу по центру, читабельний шрифт.
- [x] Fullscreen: оверлей є дитиною `.jwplayer`, не `body`.

---

## Етап 3 — Кеш, чанкінг, стабільність ✅/⚠️

**Мета:** повторний перегляд — миттєвий; великі відео — без таймаутів.

- [x] `server/cache.js`: `~/.anthropic-ua-subs/<sha256>.srt`. Функція
  `getOrTranslate` в `index.js` через `readCache`/`writeCache`.
- [x] In-flight lock: якщо той самий SRT приходить двічі одночасно —
  другий запит чекає на результат першого (не запускає дублікат).
- [x] Splitting: якщо SRT > ~10 000 TPM — ділиться на 2 половини,
  перекладаються паралельно через `Promise.all`.
- [x] Ретраї: 3 спроби з паузою `attempt * 2s`.
- [ ] Контекст між чанками: передавати 2–3 останні репліки попереднього
  чанку для кращої консистентності (ще не реалізовано).
- [ ] Явний таймаут на один Groq-запит (зараз покладається на Groq default).

---

## Етап 4 — UX розширення ✅/⚠️

**Мета:** контроль і зворотний зв'язок для користувача.

- [x] `popup.html`: тумблер **UA субтитри вкл/викл**, режим **лише UA** /
  **білінгв**, індикатор статусу сервера (зелений/червоний кружок).
- [x] `chrome.storage.sync` для збереження налаштувань.
- [x] Повідомлення в active tab при зміні налаштувань через popup.
- [ ] Slider розміру шрифту в popup.
- [ ] Індикатор стану в оверлеї: `переклад...` / `готово` / `помилка`.
- [ ] Обробка перемотування під час перекладу — плейсхолдер.

---

## Етап 5 — Якість перекладу ✅/⚠️

**Мета:** узгоджена термінологія по всіх відео курсу.

- [x] `glossary.json` — розширений список `preserveAsIs` (60+ термінів):
  `API`, `token`, `embedding`, `prompt`, `SDK`, `streaming`, `tool use`,
  `Constitutional AI`, `LLM`, `async/await`, `Promise`, мови програмування тощо.
- [x] Глосарій інжектиться в системний промпт кожного Groq-виклику.
- [ ] Ручне редагування субтитрів: shift+клік → inline textarea → override-файл.
- [ ] UI для редагування глосарію.

---

## Етап 6 — Упаковка і реліз

**Мета:** віддати друзям/колегам без болю.

- [ ] `install.sh` на macOS:
  - `npm install` в папці сервера;
  - додати `GROQ_API_KEY` в `.env`;
  - створити `~/Library/LaunchAgents/com.anthropic-ua-subs.server.plist`
    для автостарту сервера;
  - `launchctl load ...`.
- [ ] Uninstall-скрипт.
- [ ] `README.md` з кроками: отримати Groq API ключ (безкоштовно на
  console.groq.com), склонувати репо, `echo GROQ_API_KEY=... > server/.env`,
  `npm install`, запустити сервер, завантажити extension.
- [ ] Видалити застарілу перевірку `which claude` з `server/index.js`.
- [ ] Опціонально: публікація в Chrome Web Store.

---

## Подальші покращення (після v1)

- **Прогрів кешу курсу:** кнопка "перекласти всі уроки наперед" — проходить
  по плейлисту, завантажує всі .srt, перекладає у фоні.
- **Fallback на Anthropic API:** якщо Groq недоступний — перемкнутись на
  прямий виклик `anthropic.messages.create` з ключем юзера.
- **Native Messaging Host:** замість HTTP-сервера — безпечніше, без порту.
- **Інші платформи:** Udemy, Coursera, будь-що з JW Player або HLS-треками.
  - ✅ **FrontendMasters** (Video.js, `.vtt`) — додано 2026-06-07. Платформа-специфічні
    місця: домени в `manifest.json`, webRequest-фільтр `*://captions.frontendmasters.com/*.vtt`
    у `background.js`, селектори `.video-js`/`video.vjs-tech` у `content.js`, уніфікований
    SRT+VTT-парсер у `server/srt.js`. `looksEnglish` зроблено стійким до VTT-структури.
- **Експорт:** кнопка "завантажити український .srt".
- **Редагований глосарій через UI:** без ручного правлення JSON.

---

## Критичні файли

- `extension/sites.js` — ★ єдине джерело правди для всіх платформ (домени,
  патерни треків, селектори плеєра). Додати сайт = дописати сюди + `node build-manifest.js`.
- `extension/build-manifest.js` — генерує `manifest.json` з реєстру.
- `extension/content.js` — перехоплення і рендер; селектори бере з `sites.js`.
- `server/translator.js` — серце перекладу (OpenAI `gpt-5-nano`), splitting логіка.
- `server/srt.js` — універсальний парсинг SRT + WebVTT (BOM, теги, cue-settings).
- `server/glossary.json` — живий документ, буде рости.
- `server/.env` — `OPENAI_API_KEY` (не комітити!).

---

## Перевірка end-to-end

1. `cd server && npm install && node index.js` — сервер слухає :17382.
2. `curl -X POST --data-binary @../subtitle.txt http://127.0.0.1:17382/translate`
   → отримуємо UA SRT (~3–5 секунди).
3. `chrome://extensions` → **Load unpacked** → папка `extension/`.
4. Відкрити урок на `anthropic.skilljar.com`, грати відео → з'являються
   українські субтитри синхронно з мовленням.
5. Перезавантажити сторінку → субтитри з'являються миттєво (кеш).
6. Перемкнути режим у popup'і → оновлюється без перезавантаження.

---

## Ризики і мітигації

| Ризик | Мітигація |
|-------|-----------|
| Groq free tier: 12 000 TPM | Split на 2 половини при великих SRT; агресивний кеш |
| Groq rate limit (req/min) | In-flight lock запобігає дублікатам; ретраї з backoff |
| `llama-3.3-70b` повертає не-JSON | Ретраї × 3; unwrap object → array |
| GROQ_API_KEY у `.env` | `.gitignore` для `.env`; install.sh просить ввести ключ |
| Верстка Skilljar зміниться | Всі CSS-селектори в одному модулі, легко патчити |
| Порт 17382 зайнятий | Конфігурований через `PORT` env var + індикатор у popup'і |
| CORS на запиті до localhost | Express з `cors()` + `Access-Control-Allow-Private-Network` |
