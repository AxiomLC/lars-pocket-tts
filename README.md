# Test3-Voice-AI · Pocket

A minimal voice-assistant test harness. Speak into Chrome, the words go to a Groq LLM, and the reply is spoken by a local Pocket TTS engine. Replies are **streamed end to end**, so the first sentence plays while the LLM is still writing the rest. The user can **barge in** (interrupt) by speaking.

This README is written for a technical AI (or developer) who must install, run, debug, or extend the app on **Windows 11**. Read sections 1–4 before changing code.

---

## 1. At a glance

| Item | Value |
|---|---|
| URL | `http://localhost:1122` (open in **Chrome**; port set by `PORT` in `.env`) |
| Launch | `start.bat` (or `npm start`), one launching point |
| Server | Node.js ≥ 20.6, **no npm dependencies** (uses built-in `http`, `fetch`, `FormData`) |
| STT | Chrome Web Speech API (browser-side, free, needs internet and Chrome) |
| LLM | Groq, OpenAI-compatible, **streaming SSE**. Default model `llama-3.1-8b-instant` |
| TTS | Pocket TTS (`kyutai-labs/pocket-tts`), local CPU, **streaming chunked WAV** |
| Target machine | Lenovo laptop, i5-12500H, 16 GB RAM, Intel Iris Xe, **no GPU use** |

### Data flow

```
Chrome mic ──(echo-cancelled track)──► Web Speech STT
        │  2 s of silence = end of utterance
        ▼
 browser app.js ──POST /api/chat──► server.js ──► Groq (SSE stream)
        ▲                                              │ tokens
        │◄─────────── SSE passthrough ─────────────────┘
        ▼
 sentence chunker (first sentence/clause is released immediately)
        │ one sentence at a time
        ▼
 browser ──POST /api/tts {text}──► server.js ──multipart form──► Pocket TTS POST /tts
        ▲                                                              │ chunked WAV
        │◄──────────── byte stream passthrough ────────────────────────┘
        ▼
 parse 44-byte WAV header → 16-bit PCM → Web Audio scheduled gaplessly
        │  first audio starts → mic re-arms (barge-in listening)
        ▼
 speakers
```

---

## 2. File map

```
Test3-Voice-AI-Pocket/
├─ package.json        scripts.start = "node --env-file=.env server.js"   (do not change)
├─ start.bat           copies .env.example → .env if missing, opens browser, runs npm start
├─ .env.example        template for all settings (copy to .env)
├─ .env                YOUR settings and secrets (create it; never commit it)
├─ server.js           HTTP server: static files + /api/config, /api/chat, /api/tts; optional Pocket launcher
└─ public/
   ├─ index.html       markup only
   ├─ style.css        styles (state-driven via body[data-s])
   ├─ state.js         state machine: idle / listening / thinking / speaking (+ armed, rearm, testMode flags)
   └─ app.js           ALL client logic, 10 numbered sections, tunables in the CFG block at the top
```

`app.js` section index: 1 CONFIG · 2 RUNTIME STATE · 3 DOM + LOGGING · 4 STARTUP · 5 TEXT HELPERS · 6 ECHO DEFENCE · 7 SPEAKER (TTS) · 8 CHAT (LLM) · 9 LISTENING (STT) · 10 CONTROLS.

---

## 3. Windows 11 setup (step by step)

Use **PowerShell** (not WSL). All commands are for a normal, non-admin user unless noted.

### 3.1 Prerequisites

1. **Node.js 20.6 or newer** (LTS recommended)
   ```powershell
   winget install OpenJS.NodeJS.LTS
   node -v          # must print v20.6.0 or higher
   ```
   Open a **new** PowerShell window after installing so PATH updates.
2. **uv** (runs Pocket TTS in an isolated Python environment, no manual Python/pip needed)
   ```powershell
   winget install --id=astral-sh.uv -e
   # alternative: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
   uv --version
   uvx --version
   ```
3. **Google Chrome** (Web Speech STT is Chrome-only for this app; Edge/Firefox are not supported).
4. A **Groq API key** (free): https://console.groq.com/keys

### 3.2 Configure

```powershell
cd path\to\Test3-Voice-AI-Pocket
copy .env.example .env
notepad .env          # set GROQ_API_KEY=gsk_...
```
`npm start` fails immediately with `.env: not found` if `.env` does not exist. `start.bat` creates it automatically, but you must still put the key in.

### 3.3 Pre-download Pocket TTS (recommended, do once)

The first Pocket run downloads the model and voice from Hugging Face (needs internet; can take minutes). Doing it separately gives clear errors:
```powershell
uvx pocket-tts generate        # writes tts_output.wav in the current folder, prints speed stats
```
If the download fails with an authentication/gated-model error, accept the model terms on its Hugging Face page and log in with the Hugging Face CLI, then retry. Note the speed numbers it prints; they show how fast Pocket runs on this CPU.

### 3.4 Run

```powershell
.\start.bat        # opens Chrome tab at `http://localhost:<PORT from .env>` and starts everything
# or:
npm start
```
`server.js` launches Pocket TTS itself because `.env` contains `POCKET_CMD=uvx pocket-tts serve`. Watch the console: it prints `[pocket-tts] started` and Pocket's own startup output. The page's log panel says "Waiting for Pocket TTS to load…" and retries for up to ~75 s, then prints `Pocket TTS warm: first byte … ms`.

**To run Pocket yourself** (for example in a second terminal to see its logs): blank out `POCKET_CMD=` in `.env`, then run `uvx pocket-tts serve --port 1133` separately. If a Pocket server is already answering at `POCKET_URL`, the app reuses it and never stops it on exit.

### 3.5 Browser and Windows audio settings

- Open the app in **Chrome**, click **Talk** once and **Allow** the microphone prompt. `localhost` counts as a secure context, so no HTTPS is needed. Chrome treats each port as a different site, so allow the mic again if you change `PORT`.
- Chrome uses the **default** Windows input/output devices (Settings → System → Sound). Set them first.
- **Use headphones** for reliable barge-in (see section 7). With speakers, press **Echo test** to measure leakage.
- Windows Firewall may prompt for Node.js or Python. Allow **private** networks, since everything is `localhost`.

### 3.6 Stopping and cleaning up

Press `Ctrl+C` in the console. `server.js` kills the whole Pocket process tree with `taskkill /T /F`. If a crash leaves Pocket running (the next start then fails with the port in use):
```powershell
netstat -ano | findstr :1133
taskkill /PID <pid> /T /F
```

---

## 4. Configuration reference (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `1122` | Web UI/API port. `start.bat` reads this too, so it is the only place to change it |
| `GROQ_API_KEY` | (empty) | **Required.** Free key from console.groq.com |
| `GROQ_MODEL` | `llama-3.1-8b-instant` | Fast, non-reasoning, about 560 tok/s. Smarter but slower: `llama-3.3-70b-versatile`. Avoid reasoning models (they delay the first token) |
| `GROQ_URL` | Groq chat-completions URL | OpenAI-compatible endpoint (also lets you point at a mock or another provider) |
| `SYSTEM_PROMPT` | short spoken replies | Keep it short and ban markdown, since replies are read aloud |
| `MAX_TOKENS` | `200` | Reply length cap (also protects Groq's free-tier token-per-minute limit) |
| `HISTORY_TURNS` | `6` | Last N user/assistant pairs sent to the LLM |
| `POCKET_URL` | `http://localhost:1133/tts` | Pocket TTS streaming endpoint. If a server already answers `/health` here it is reused |
| `POCKET_VOICE` | `alba` | Built-in voice name, or an `http`/`https`/`hf://` URL. Sent as form field `voice_url` |
| `POCKET_CMD` | `uvx pocket-tts serve --port 1133` | Command the server runs at startup. Blank = you run Pocket yourself |

Groq free tier (as researched): 30 requests/min, 6,000 tokens/min and 14,400 requests/day for `llama-3.1-8b-instant`. A 429 error appears in the log if exceeded. Groq's docs page listed that model as "Contact Sales" for the paid Developer plan, so confirm it still works on your key.

---

## 5. Interface contracts (verify these first if something breaks)

### Pocket TTS (upstream, from the project's docs)
- `GET /health` → `{"status":"ok"}`
- `POST /tts`, **multipart form**: `text` (required), `voice_url` (optional), `voice_wav` (optional file upload for cloning)
- Response: `audio/wav`, `Transfer-Encoding: chunked`. A **44-byte WAV header**, then **16-bit little-endian PCM, mono, 24 kHz**. The header length fields are not reliable for streaming, so the client never trusts them. It reads only the sample rate (bytes 24–27).
- The model generates faster than real time (≈6× on an Apple M4; **not measured on this i5-12500H**).

### This app's server (`server.js`)
| Endpoint | Request | Response |
|---|---|---|
| `GET /api/config` | none | JSON: host specs, Groq model, `keySet`, Pocket URL/voice, `pocketUp` (health check) |
| `POST /api/chat` | JSON `{messages:[{role,content}]}` | `text/event-stream`, a passthrough of Groq SSE (`data: {choices:[{delta:{content}}]}` … `data: [DONE]`) |
| `POST /api/tts` | JSON `{text}` | `audio/wav` byte stream, a passthrough of Pocket's response |
| static | any other path | files from `public/` |

Both streaming routes abort the upstream request when the browser disconnects. This is what makes **barge-in cancel LLM generation and TTS generation**, not just playback.

---

## 6. Behavior details

### Turn taking
1. **Talk** opens the mic. Words accumulate; each new word restarts a **2000 ms** silence timer (`CFG.SILENCE_MS`).
2. Timer fires → mic closes → text is sent to the LLM (state `thinking`).
3. First audio becomes audible (state `speaking`) → if **Re-arm** is on, the mic re-opens for barge-in.
4. Playback ends → state `listening` (re-arm on) or `idle`.

### Sentence chunking (what makes the first audio fast)
`makeChunker` releases text to TTS at the first sentence end (≥ 8 chars), or at a comma or colon after ≥ 40 chars for the first chunk only. Later chunks are ≥ 24 chars. Markdown symbols are stripped before TTS.

### Gapless playback
Each sentence is fetched sequentially. PCM arrives in chunks and is scheduled on the Web Audio clock (`nextStart`), so chunks butt together. Chunk sizes are in `CFG` (2400 bytes first, 4800 after). An `Audio underrun` log line means TTS is slower than playback.

### State machine (`state.js`)
`idle ⇄ listening → thinking → speaking → listening/idle`. Unexpected transitions are applied but logged as warnings (`State: a → b` in amber). Never set UI state outside `State.set()`.

### Cancellation
`cancelEverything()` bumps `run.gen`, aborts the LLM fetch and calls `speaker.reset()`. Any async code checks `stale()`/`this.id` before acting. Keep that pattern in any new async code.

---

## 7. Echo / self-hearing defence

Speakers feed the assistant's voice back into the mic. Layers, in order:
1. **Echo-cancelled mic track.** `getUserMedia({echoCancellation, noiseSuppression, autoGainControl})` then `recognition.start(track)`. This relies on Chrome supporting `SpeechRecognition.start(MediaStreamTrack)`. On unsupported versions Chrome silently ignores the argument and uses the default mic. The log prints `echoCancellation=true/false`.
2. **Text-match filter** (`echoVerdict`). While speaking, and for `TAIL_MS` after, heard words are compared with the text being spoken. Barge-in fires only if at least `BARGE_MIN_NOVEL` (2) words are new, or the user says an interrupt word (`stop, wait, cancel, pause, hold, no, quiet, enough`).
3. **Grace period** (`BARGE_GRACE_MS`, 500 ms) and tail window.

**Not guaranteed on speakers. Headphones are the only certain fix.** The **Echo test** button plays a line while the user stays silent and logs anything the mic hears (`heard during playback: …`). No such lines = clean. If leakage persists: lower speaker volume, raise `BARGE_MIN_NOVEL` to 3, or turn **Re-arm: Off** (half-duplex).

---

## 8. Log lines (page log panel and DevTools console, prefix `[Voice]`)

Open DevTools with `F12` → Console. Colours in the page: green = good, amber = warning, red = error.

| Log line | Meaning |
|---|---|
| `State: x → y` | state machine transition |
| `Pocket TTS warm: first byte N ms` | Pocket is up. N is its cold-start latency |
| `Mic: <device> \| echoCancellation=true` | the mic track got AEC. `false` = use headphones |
| `Silence 2000 ms → sending: "…"` | utterance committed |
| `LLM first token N ms` / `LLM done` | Groq latency and total |
| `First sentence ready @ N ms` | when the chunker released sentence one |
| `TTS "…" first byte N ms, total M ms → S s audio (RTF r)` | per-sentence Pocket timing. **RTF < 1 is good**, > 1 (amber) means TTS is slower than real time |
| `TTFA (send → first audio): N ms` | **the key metric**: from sending text to audible sound |
| `heard during playback: "…" → echo, ignored / REAL speech` | echo filter decisions |
| `Cut: barge-in` | user interrupted; LLM and TTS were aborted |
| `Audio underrun` | audio gap because TTS was too slow |
| `Chat error:` / `TTS error:` / `STT error:` | see troubleshooting |

---

## 9. Troubleshooting (Windows 11)

| Symptom | Likely cause | Fix |
|---|---|---|
| `node: .env: not found` | no `.env` file | `copy .env.example .env` |
| `node: bad option: --env-file` | Node older than 20.6 | install Node LTS |
| Warning `MODULE_TYPELESS_PACKAGE_JSON` | `package.json` has no `"type"` | harmless; intentionally not changed |
| `'uvx' is not recognized` | uv not installed or stale PATH | install uv, open a new terminal |
| Log: "Waiting for Pocket TTS…" for a long time | first-run model download, or Pocket crashed | read the Pocket output in the server console. Run `uvx pocket-tts serve` manually to see it |
| `Pocket TTS 4xx/5xx` in log | wrong voice name or bad request | set `POCKET_VOICE=alba` |
| `Address already in use` on 1122 or 1133 | leftover process or another app | see 3.6, or change `PORT` / `POCKET_URL` and the `--port` in `POCKET_CMD` |
| `Groq 401` | bad or missing key | fix `GROQ_API_KEY` |
| `Groq 404 model_not_found` | model id changed or unavailable | check console.groq.com/docs/models and set `GROQ_MODEL` |
| `Groq 429` | free-tier rate limit | wait a minute, lower `MAX_TOKENS`/`HISTORY_TURNS` |
| `STT error: not-allowed` | mic blocked | Chrome lock icon → allow microphone. Check Windows Settings → Privacy → Microphone |
| `STT error: network` | Web Speech needs internet | check connection |
| No sound, but TTS lines are logged | AudioContext blocked or wrong output device | click Talk or Send first (user gesture). Check the Windows output device |
| `Audio underrun` or RTF > 1 repeatedly | Pocket too slow on this CPU | raise `CFG.FIRST_CHUNK_BYTES`/`CHUNK_BYTES` to add buffer, close other apps, consider `uvx pocket-tts serve --quantize` (set in `POCKET_CMD`) |
| Assistant interrupts itself | echo leakage | headphones, run Echo test, see section 7 |
| UI stuck in `thinking` | upstream hung | press Stop; check log for the failing hop |

---

## 10. How to extend safely

- **Change a timing or threshold:** edit only `CFG` at the top of `public/app.js`.
- **Different TTS voice or language:** `POCKET_VOICE` in `.env`. Languages are chosen when Pocket starts, e.g. `POCKET_CMD=uvx pocket-tts serve --language french_24l`.
- **Connect Hermes (future):** in `server.js`, the `/api/chat` route has a commented **HERMES HOOK** block. Replace the Groq `fetch` with a call to the Hermes profile endpoint. Keep the response format as OpenAI-style SSE (`data: {choices:[{delta:{content}}]}`), or adapt the parser in `app.js` section 8c. Connection notes live in the `AxiomLC/lars13` repo.
- **Keep these invariants:** the server stays a thin passthrough (no buffering of streams); every async path checks the cancellation guard; UI state only changes via `State.set()`; the log function is the single place that writes to both the page and the console.
- **Do not** add npm dependencies or change `package.json` unless asked. The app is deliberately dependency-free.

---

## 11. Verification status (be honest about what was tested)

| Area | Status |
|---|---|
| `server.js` routing, static MIME types, SSE passthrough, TTS byte-stream passthrough, multipart fields `text`/`voice_url` | **Tested** against mock Groq and Pocket servers (Linux sandbox, Node 22) |
| JavaScript syntax of all files; every DOM id used by `app.js` exists in `index.html` | **Checked** |
| Pocket `/tts` request/response contract | **From documentation** (project docs and a code-derived wiki), not run against a live Pocket |
| Real Groq streaming and model availability on the user's key | **Not tested** |
| Browser behavior: Web Speech, `start(track)` support, echo cancellation, gapless audio, barge-in | **Not tested in a browser.** Needs a first run on the Windows machine |
| Pocket speed (RTF) on the i5-12500H | **Unmeasured.** Read it from the first `TTS …` log lines |
| `taskkill` cleanup of the Pocket process tree on Windows | **Written but not tested on Windows** |

**Suggested first-run checklist:** (1) `npm start`, (2) see `Pocket TTS warm`, (3) click **Echo test** and read the log, (4) type a message with **Keyboard** and note `TTFA`, (5) use **Talk**, speak, and let it answer, (6) speak over a reply to test barge-in. Report the log lines from each step.

---

## 12. Changing ports

Edit **`.env` only**: `PORT` (app) and `POCKET_URL` plus the `--port` number in `POCKET_CMD` (Pocket TTS; the two must match). `server.js` falls back to 1122 / 1133 if they are missing, and `start.bat` reads `PORT` from `.env` for the browser URL. Check a port is free with `netstat -ano | findstr :<port>` and make sure it is not inside `netsh int ipv4 show excludedportrange protocol=tcp`.
