/* =====================================================================
   app.js — Test3-Voice-AI · Pocket

   WHAT IT DOES
     Talk → Web Speech STT → 2 s silence → Groq LLM (streamed) → sentence chunker
          → Pocket TTS (streamed WAV) → gapless Web Audio playback.
     The first sentence starts playing while the LLM is still writing the rest.
     The mic re-opens when reply audio starts, so the user can barge in.

   SECTIONS
     1. CONFIG ............ every tunable number, with what it does
     2. RUNTIME STATE ..... the few mutable values (state machine lives in state.js)
     3. DOM + LOGGING ..... element refs; log() writes to the page AND the DevTools console
     4. STARTUP ........... specs panel, Pocket TTS warm-up
     5. TEXT HELPERS ...... speech cleaning, sentence chunker
     6. ECHO DEFENCE ...... echo-cancelled mic track, "is this just my own voice?" filter
     7. SPEAKER (TTS) ..... Pocket stream → PCM → scheduled playback
     8. CHAT (LLM) ........ Groq SSE stream → chunker → speaker
     9. LISTENING (STT) ... Web Speech recognizer, silence timer, barge-in
    10. CONTROLS .......... button handlers

   DEPENDS ON: state.js (global `State`), server.js endpoints /api/config, /api/chat, /api/tts
   LOGGING: look for the "[Voice]" prefix in DevTools → Console (errors use console.error).
   ===================================================================== */
'use strict';


/* =====================================================================
   1. CONFIG — tweak here
   ===================================================================== */
const CFG = {
  // --- Turn taking ---
  SILENCE_MS: 2000,        // silence after the last heard word before the utterance is sent
  STT_LANG: 'en-US',

  // --- Barge-in / echo defence (see section 6) ---
  BARGE_GRACE_MS: 500,     // ignore speech this long after audio starts (initial sound burst)
  BARGE_MIN_NOVEL: 2,      // heard words NOT found in the assistant's own text needed to count as the user
  BARGE_WORDS: new Set(['stop', 'wait', 'cancel', 'pause', 'hold', 'no', 'quiet', 'enough']), // 1-word interrupts
  TAIL_MS: 1800,           // keep filtering for this long after playback ends (echo tail)

  // --- Sentence chunker: when to hand text to TTS ---
  FIRST_SENTENCE_MIN: 8,   // first chunk may be short → fastest first audio
  SENTENCE_MIN: 24,        // later chunks: merge tiny sentences up to this many chars
  FIRST_CLAUSE_MIN: 40,    // if no sentence end yet, cut the FIRST chunk at a comma after this many chars

  // --- Audio scheduling ---
  FIRST_CHUNK_BYTES: 2400, // PCM bytes to gather before the very first buffer (~50 ms @ 24 kHz 16-bit)
  CHUNK_BYTES: 4800,       // later buffers (~100 ms); bigger = fewer buffers, smaller = lower latency
  DEFAULT_RATE: 24000,     // Pocket TTS sample rate (the WAV header is trusted when present)

  // --- Pocket warm-up on page load ---
  WARMUP_TRIES: 25,
  WARMUP_RETRY_MS: 3000,
};


/* =====================================================================
   2. RUNTIME STATE
   ===================================================================== */
const run = {
  history: [],        // chat history sent to the LLM [{role, content}]
  gen: 0,             // "generation" counter: bumped on every cancel so stale async work can bail out
  llmAbort: null,     // AbortController for the in-flight LLM request
  audioCtx: null,     // Web Audio context (created on first user gesture)
  spokenText: '',     // everything we've handed to TTS this turn (used by the echo filter)
  lastSpeechEnd: 0,   // performance.now() when playback last finished
  speakingStart: 0,   // performance.now() when audio actually became audible
};

const stt = {
  rec: null,          // SpeechRecognition instance
  running: false,     // recognizer currently started
  starting: false,    // guards against double-start while the mic is being opened
  buf: '',            // finalized words of the current utterance
  interim: '',        // not-yet-final words
  silenceTimer: null,
  mic: null,          // MediaStream with echo cancellation on
  track: null,        // cloned track handed to the current recognizer session
  lastHeardLog: '',   // de-duplicates "heard during playback" log lines
};

const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;


/* =====================================================================
   3. DOM + LOGGING
   ===================================================================== */

/* ---- 3a. Element references ---- */
const $ = sel => document.querySelector(sel);
const el = {
  chat: $('#chat'), log: $('#log'), specs: $('#specs'), status: $('#status'), interim: $('#interim'),
  mic: $('#mic'), rearm: $('#rearm'), kbd: $('#kbd'), stop: $('#stop'), echo: $('#echo'), clear: $('#clear'),
  typed: $('#typed'), txt: $('#txt'), send: $('#send'),
};

/* ---- 3b. Logging: page log panel + DevTools console ----
   level: '' (info) | 'ok' | 'warn' | 'err' */
function log(msg, level = '') {
  const row = document.createElement('div');
  row.className = level;
  row.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.log.append(row);
  el.log.scrollTop = el.log.scrollHeight;

  const method = { err: 'error', warn: 'warn', ok: 'info' }[level] || 'log';
  console[method](`[Voice] ${msg}`);
}

/* ---- 3c. Misc UI helpers ---- */
const elapsed = t0 => Math.round(performance.now() - t0);      // ms since t0

function addBubble(role, text, extraClass = '') {                // role: 'u' (user) | 'a' (assistant)
  const b = document.createElement('div');
  b.className = `m ${role} ${extraClass}`;
  b.textContent = text;
  el.chat.append(b);
  el.chat.scrollTop = el.chat.scrollHeight;
  return b;
}

/* ---- 3d. React to state machine changes: update UI + log every transition ---- */
State.onChange((prev, next, label, expected) => {
  document.body.dataset.s = next;
  el.status.textContent = label || next[0].toUpperCase() + next.slice(1);
  if (prev !== next) log(`State: ${prev} → ${next}`, expected ? '' : 'warn');
  if (!expected) console.warn(`[Voice] unexpected transition ${prev} → ${next}`);
});

/* ---- 3e. Catch anything we didn't handle ---- */
window.addEventListener('error', e => log(`JS error: ${e.message} (${e.filename}:${e.lineno})`, 'err'));
window.addEventListener('unhandledrejection', e => log(`Unhandled promise rejection: ${e.reason?.message || e.reason}`, 'err'));


/* =====================================================================
   4. STARTUP
   ===================================================================== */

/* ---- 4a. Fill the specs panel from the server ---- */
fetch('/api/config')
  .then(r => r.json())
  .then(c => {
    el.specs.textContent =
      `Host   ${c.host}\n` +
      `GPU    none (Intel Iris Xe, CPU only)\n` +
      `LLM    Groq ${c.model} (streaming)  key:${c.keySet ? 'set' : 'MISSING'}\n` +
      `TTS    Pocket TTS ${c.pocketUrl}  voice:${c.voice}\n` +
      `STT    ${SpeechRecognitionCtor ? 'Web Speech (Chrome)' : 'NOT SUPPORTED — use Chrome'}\n` +
      `Silence timeout ${CFG.SILENCE_MS} ms`;
    log(`Config loaded: model ${c.model}, voice ${c.voice}`);
    if (!c.keySet) log('GROQ_API_KEY is missing in .env', 'err');
    warmUpPocket();
  })
  .catch(e => log(`Could not load /api/config: ${e.message}`, 'err'));

if (!SpeechRecognitionCtor) log('Web Speech API unavailable. Use Chrome (typing still works).', 'err');

/* ---- 4b. Warm up Pocket TTS so the first real reply isn't slow (also logs cold-start time) ---- */
async function warmUpPocket(attempt = 0) {
  const t0 = performance.now();
  try {
    const r = await fetch('/api/tts', jsonPost({ text: 'Ready.' }));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    const reader = r.body.getReader();
    let firstByteMs = 0;
    for (;;) {
      const { done } = await reader.read();
      if (!firstByteMs) firstByteMs = elapsed(t0);
      if (done) break;
    }
    log(`Pocket TTS warm: first byte ${firstByteMs} ms, total ${elapsed(t0)} ms`, 'ok');
  } catch (e) {
    if (attempt < CFG.WARMUP_TRIES) {
      if (attempt === 0) log('Waiting for Pocket TTS to load (first run downloads the model)…', 'warn');
      setTimeout(() => warmUpPocket(attempt + 1), CFG.WARMUP_RETRY_MS);
    } else {
      log(`Pocket TTS unreachable after ${CFG.WARMUP_TRIES} tries: ${e.message}`, 'err');
    }
  }
}

/** fetch() options for a JSON POST (optionally cancellable). */
function jsonPost(body, signal) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal };
}

/** The Web Audio context must be created/resumed from a user gesture. */
function getAudioCtx() {
  if (!run.audioCtx) run.audioCtx = new AudioContext();
  if (run.audioCtx.state === 'suspended') run.audioCtx.resume();
  return run.audioCtx;
}


/* =====================================================================
   5. TEXT HELPERS
   ===================================================================== */

/** Strip markdown-ish symbols the TTS would read aloud, collapse whitespace. */
function cleanForSpeech(text) {
  return text.replace(/[*_`#>~]+/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Sentence chunker. Feed it streamed LLM text with push(); it calls emit(sentence)
 * the moment a sentence (or, for the very first chunk only, a long clause) is complete.
 * flush() emits whatever is left when the stream ends.
 */
function makeChunker(emit) {
  let buffer = '';
  let isFirst = true;

  /** Index just past the next cut point in `buffer`, or -1 if none yet. */
  function findCut() {
    // Sentence end (. ! ? …) followed by whitespace, or a newline
    const sentenceEnd = /[.!?…]+["')\]]*\s|\n/g;
    let m;
    while ((m = sentenceEnd.exec(buffer))) {
      const end = m.index + m[0].length;
      const minLen = isFirst ? CFG.FIRST_SENTENCE_MIN : CFG.SENTENCE_MIN;
      if (buffer.slice(0, end).trim().length >= minLen) return end;
    }
    // First chunk only: accept a clause break so audio can start earlier
    if (isFirst) {
      const clauseEnd = /[,;:–—]\s/g;
      while ((m = clauseEnd.exec(buffer))) {
        const end = m.index + m[0].length;
        if (end >= CFG.FIRST_CLAUSE_MIN) return end;
      }
    }
    return -1;
  }

  function emitText(text) {
    const clean = cleanForSpeech(text);
    if (clean) { isFirst = false; emit(clean); }
  }

  return {
    push(delta) {
      buffer += delta;
      let cut;
      while ((cut = findCut()) > 0) { emitText(buffer.slice(0, cut)); buffer = buffer.slice(cut); }
    },
    flush() { emitText(buffer); buffer = ''; },
  };
}


/* =====================================================================
   6. ECHO DEFENCE — keep the assistant from hearing (and obeying) itself
   Three layers:
     1. The mic is opened with echoCancellation and that processed track is given to
        SpeechRecognition.start(track) (Chrome only supports this on newer versions).
     2. While we talk — and for TAIL_MS after — anything heard is compared with the text
        we are speaking. If fewer than BARGE_MIN_NOVEL words are new, it's treated as echo.
     3. A short grace period after audio starts, plus the tail window above.
   Headphones remain the only guarantee. Use the "Echo test" button to measure leakage.
   ===================================================================== */

/** Lowercase word list: "Hello, World!" → ['hello','world'] */
const toWords = text => text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean);

/**
 * Decide whether `heard` is just our own voice.
 * Returns { echo: boolean, novel: string[] } where `novel` = words not found in what we said.
 * A word counts as "found" if it matches exactly or shares a 4-letter prefix with a spoken word
 * (STT often mangles word endings: "files" → "file").
 */
function echoVerdict(heard) {
  const spoken = toWords(run.spokenText);
  const spokenSet = new Set(spoken);
  const isOurs = w =>
    spokenSet.has(w) ||
    (w.length > 3 && spoken.some(s => s.length > 3 && (s.startsWith(w.slice(0, 4)) || w.startsWith(s.slice(0, 4)))));

  const novel = toWords(heard).filter(w => !isOurs(w));
  const hasInterruptWord = novel.some(w => CFG.BARGE_WORDS.has(w));
  return { echo: !(novel.length >= CFG.BARGE_MIN_NOVEL || hasInterruptWord), novel };
}

/** Open the mic once with echo cancellation + noise suppression; log what Chrome actually granted. */
async function ensureMic() {
  if (stt.mic && stt.mic.getAudioTracks()[0]?.readyState === 'live') return true;
  try {
    stt.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const track = stt.mic.getAudioTracks()[0];
    const s = track.getSettings();
    log(`Mic: ${track.label} | echoCancellation=${s.echoCancellation} noiseSuppression=${s.noiseSuppression}`,
        s.echoCancellation ? 'ok' : 'warn');
    if (!s.echoCancellation) log('Browser did not enable echo cancellation on this mic — use headphones', 'err');
    return true;
  } catch (e) {
    log(`Mic access failed: ${e.message}`, 'err');
    return false;
  }
}


/* =====================================================================
   7. SPEAKER (TTS) — Pocket TTS stream → PCM → gapless playback

   Pocket's POST /tts answers with a chunked WAV: a 44-byte header, then 16-bit PCM
   (mono, 24 kHz). decodeAudioData() needs a complete file, so we parse the header
   ourselves and schedule each PCM chunk on the Web Audio clock as it arrives.
   Sentences are fetched one after another; each is queued right behind the audio already
   playing, so playback is gapless (Pocket generates faster than real time).
   ===================================================================== */
class Speaker {
  constructor() { this.id = 0; this.reset(); }

  /** Cancel everything (in-flight fetch, queued sentences, scheduled audio) and start clean. */
  reset() {
    this.id++;                                   // invalidates any async work from the previous run
    try { this.abortCtl && this.abortCtl.abort(); } catch {}
    (this.sources || []).forEach(s => { try { s.onended = null; s.stop(); } catch {} });
    this.sources = new Set();                    // audio nodes currently scheduled/playing
    this.queue = [];                             // sentences waiting for TTS
    this.nextStart = 0;                          // audio-clock time where the next chunk begins
    this.running = false;                        // fetch loop active
    this.ended = false;                          // LLM finished: no more sentences coming
    this.gotFirstAudio = false;
    this.doneFired = false;
    this.onFirstAudio = () => {};                // set by the caller each turn
    this.onDone = () => {};
  }

  /** Add a sentence to be spoken. */
  push(text) { this.queue.push(text); if (!this.running) this.run(); }

  /** Signal that no more sentences will be pushed. */
  end() { this.ended = true; this.checkDone(); }

  /* ---- 7a. Fetch loop: one sentence at a time ---- */
  async run() {
    const myId = this.id;
    this.running = true;
    while (this.queue.length && myId === this.id) {
      const text = this.queue.shift();
      try { await this.speakOne(text, myId); }
      catch (e) { if (myId === this.id && e.name !== 'AbortError') log(`TTS error: ${e.message}`, 'err'); }
    }
    if (myId === this.id) { this.running = false; this.checkDone(); }
  }

  /** Stream one sentence from Pocket and schedule its audio as bytes arrive. */
  async speakOne(text, myId) {
    const t0 = performance.now();
    this.abortCtl = new AbortController();
    const resp = await fetch('/api/tts', jsonPost({ text }, this.abortCtl.signal));
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const header = new Uint8Array(44);
    let headerBytes = 0, sampleRate = CFG.DEFAULT_RATE;
    let pending = new Uint8Array(0);            // PCM bytes received but not yet scheduled
    let firstByteMs = 0, totalBytes = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (myId !== this.id) return;             // cancelled while waiting
      if (done) break;
      if (!firstByteMs) firstByteMs = elapsed(t0);

      let data = value;

      // -- parse the 44-byte WAV header (may arrive split across chunks) --
      if (headerBytes < 44) {
        const n = Math.min(44 - headerBytes, data.length);
        header.set(data.subarray(0, n), headerBytes);
        headerBytes += n;
        data = data.subarray(n);
        if (headerBytes === 44) {
          if (String.fromCharCode(...header.subarray(0, 4)) !== 'RIFF') log('Pocket stream did not start with a RIFF header', 'warn');
          sampleRate = new DataView(header.buffer).getUint32(24, true) || CFG.DEFAULT_RATE;
        }
      }

      // -- accumulate PCM, schedule once we have enough --
      if (data.length) {
        const merged = new Uint8Array(pending.length + data.length);
        merged.set(pending); merged.set(data, pending.length);
        pending = merged;
        const usable = pending.length - (pending.length % 2);          // whole 16-bit samples only
        const minBytes = this.gotFirstAudio ? CFG.CHUNK_BYTES : CFG.FIRST_CHUNK_BYTES;
        if (usable >= minBytes) {
          this.schedule(pending.slice(0, usable), sampleRate);
          totalBytes += usable;
          pending = pending.slice(usable);
        }
      }
    }

    // stream ended: play whatever is left
    const tail = pending.length - (pending.length % 2);
    if (tail >= 2) { this.schedule(pending.slice(0, tail), sampleRate); totalBytes += tail; }

    // per-sentence timing → real-time factor (RTF < 1 means TTS is faster than playback)
    const audioSecs = totalBytes / 2 / sampleRate;
    const rtf = elapsed(t0) / 1000 / Math.max(audioSecs, 0.01);
    const shown = text.length > 34 ? text.slice(0, 34) + '…' : text;
    log(`TTS "${shown}" first byte ${firstByteMs} ms, total ${elapsed(t0)} ms → ${audioSecs.toFixed(1)}s audio (RTF ${rtf.toFixed(2)})`,
        rtf > 1 ? 'warn' : '');
  }

  /* ---- 7b. Turn a PCM chunk into an AudioBuffer and put it on the audio clock ---- */
  schedule(pcmBytes, sampleRate) {
    const ctx = getAudioCtx();
    const samples = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);
    const audioBuf = ctx.createBuffer(1, samples.length, sampleRate);
    const channel = audioBuf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;   // int16 → float [-1, 1]

    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    if (this.nextStart && this.nextStart < now) log('Audio underrun (TTS slower than playback)', 'warn');
    // small lead on the very first chunk avoids a click; afterwards butt chunks end-to-end
    const startAt = Math.max(now + (this.nextStart ? 0.01 : 0.05), this.nextStart);
    src.start(startAt);
    this.nextStart = startAt + audioBuf.duration;

    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); this.checkDone(); };

    if (!this.gotFirstAudio) {                   // fire "first audio" when it actually becomes audible
      this.gotFirstAudio = true;
      const myId = this.id;
      setTimeout(() => { if (myId === this.id) this.onFirstAudio(); }, Math.max(0, (startAt - now) * 1000));
    }
  }

  /** Fire onDone once: LLM finished, nothing queued, nothing still playing. */
  checkDone() {
    if (this.ended && !this.running && !this.queue.length && !this.sources.size && !this.doneFired) {
      this.doneFired = true;
      this.onDone();
    }
  }
}

const speaker = new Speaker();

/** Cancel the LLM stream and all audio. Used by barge-in, Stop, and starting a new turn. */
function cancelEverything(reason) {
  run.gen++;
  try { run.llmAbort && run.llmAbort.abort(); } catch {}
  speaker.reset();
  if (reason) log(`Cut: ${reason}`, 'warn');
}


/* =====================================================================
   8. CHAT (LLM) — Groq SSE stream → chunker → speaker
   ===================================================================== */
async function sendToLLM(userText) {
  cancelEverything();
  const myGen = run.gen;                         // if run.gen changes, this turn was cancelled
  const stale = () => myGen !== run.gen;

  addBubble('u', userText);
  run.history.push({ role: 'user', content: userText });
  run.spokenText = '';
  State.set('thinking', 'Thinking…');

  const tSend = performance.now();
  const bubble = addBubble('a', '…', 'i');
  let fullReply = '';
  let firstSentenceLogged = false;

  /* ---- 8a. Hooks fired by the speaker ---- */
  speaker.onFirstAudio = () => {
    if (stale()) return;
    run.speakingStart = performance.now();
    State.set('speaking');
    log(`TTFA (send → first audio): ${elapsed(tSend)} ms`, 'ok');
    if (State.rearm) { log('Mic re-armed (barge-in active)'); State.armed = true; startListening(); }
  };
  speaker.onDone = () => {
    if (stale()) return;
    run.lastSpeechEnd = performance.now();
    log('Playback done');
    State.set(State.armed && State.rearm ? 'listening' : 'idle');
  };

  /* ---- 8b. Chunker → speaker ---- */
  const chunker = makeChunker(sentence => {
    if (stale()) return;
    if (!firstSentenceLogged) { firstSentenceLogged = true; log(`First sentence ready @ ${elapsed(tSend)} ms: "${sentence.slice(0, 40)}"`); }
    run.spokenText += ' ' + sentence;
    speaker.push(sentence);
  });

  /* ---- 8c. Stream the reply ---- */
  run.llmAbort = new AbortController();
  try {
    const resp = await fetch('/api/chat', jsonPost({ messages: run.history }, run.llmAbort.signal));
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || `HTTP ${resp.status}`);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '', firstTokenMs = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      // Server-sent events: one "data: {json}" per line, "[DONE]" at the end
      let nl;
      while ((nl = sseBuffer.indexOf('\n')) >= 0) {
        const line = sseBuffer.slice(0, nl).trim();
        sseBuffer = sseBuffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let delta;
        try { delta = JSON.parse(payload).choices?.[0]?.delta?.content; } catch { continue; }
        if (!delta) continue;

        if (!firstTokenMs) { firstTokenMs = elapsed(tSend); log(`LLM first token ${firstTokenMs} ms`, 'ok'); }
        fullReply += delta;
        bubble.className = 'm a';
        bubble.textContent = fullReply;
        el.chat.scrollTop = el.chat.scrollHeight;
        chunker.push(delta);
      }
    }

    if (stale()) return;
    chunker.flush();
    log(`LLM done ${elapsed(tSend)} ms, ${fullReply.length} chars`);
    if (!fullReply.trim()) throw new Error('empty reply from LLM');
    run.history.push({ role: 'assistant', content: fullReply });
    speaker.end();

  } catch (e) {
    if (e.name === 'AbortError') {               // barge-in / Stop: keep what was said so far
      if (fullReply) run.history.push({ role: 'assistant', content: fullReply + ' [interrupted]' });
      else bubble.remove();
      return;
    }
    bubble.remove();
    log(`Chat error: ${e.message}`, 'err');
    addBubble('a', `Error: ${e.message}`, 'i');
    State.set(State.armed ? 'listening' : 'idle');
    if (State.armed && State.rearm) startListening();
  }
}


/* =====================================================================
   9. LISTENING (STT) — Web Speech recognizer, silence timer, barge-in
   ===================================================================== */

/** Start a recognizer session (restarts itself on end while State.armed is true). */
async function startListening() {
  if (!SpeechRecognitionCtor || stt.running || stt.starting) return;
  stt.starting = true;
  if (!stt.mic) await ensureMic();
  stt.starting = false;
  if (stt.running || !State.armed) return;

  const rec = new SpeechRecognitionCtor();
  stt.rec = rec;
  rec.lang = CFG.STT_LANG;
  rec.continuous = true;
  rec.interimResults = true;

  /* ---- 9a. Lifecycle ---- */
  rec.onstart = () => {
    stt.running = true;
    log('STT session started');
    if (!State.is('speaking')) State.set('listening');
  };
  rec.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;       // routine, not worth logging
    log(`STT error: ${e.error}`, 'err');
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      State.armed = false;
      State.set('idle', 'Mic blocked');
    }
  };
  rec.onend = () => {
    stt.running = false;
    try { stt.track && stt.track.stop(); } catch {}
    stt.track = null;
    // Chrome ends sessions on its own after silence — restart while the user wants the mic open
    if (State.armed && !State.is('thinking')) setTimeout(startListening, 150);
    else if (!State.armed && State.is('listening')) State.set('idle');
  };

  /* ---- 9b. Results: collect words, filter echo, detect barge-in, (re)start silence timer ---- */
  rec.onresult = ev => {
    let finalText = '', interimText = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const t = ev.results[i][0].transcript;
      if (ev.results[i].isFinal) finalText += t; else interimText += t;
    }
    if (finalText) stt.buf += (stt.buf ? ' ' : '') + finalText.trim();
    stt.interim = interimText;

    const heard = (stt.buf + ' ' + stt.interim).trim();
    el.interim.textContent = heard;
    if (!heard) return;

    // While we are speaking (and shortly after), most of what the mic hears may be our own voice
    const inEchoWindow = State.is('speaking') || performance.now() - run.lastSpeechEnd < CFG.TAIL_MS;
    if (inEchoWindow) {
      const verdict = echoVerdict(heard);
      if (heard !== stt.lastHeardLog) {
        stt.lastHeardLog = heard;
        log(`heard during playback: "${heard.slice(0, 60)}" → ${verdict.echo ? 'echo, ignored' : 'REAL speech'} [new words: ${verdict.novel.join(' ') || '-'}]`,
            verdict.echo ? 'ok' : 'warn');
      }
      if (verdict.echo || State.testMode) {      // discard: never let our own voice become a user turn
        stt.buf = ''; stt.interim = ''; el.interim.textContent = '';
        return;
      }
      if (State.is('speaking')) {                // genuine user speech → barge-in
        if (performance.now() - run.speakingStart < CFG.BARGE_GRACE_MS) return;
        cancelEverything('barge-in');
        State.set('listening');
      }
    }

    clearTimeout(stt.silenceTimer);
    stt.silenceTimer = setTimeout(commitUtterance, CFG.SILENCE_MS);
  };

  /* ---- 9c. Start, preferring the echo-cancelled track ---- */
  try {
    if (stt.mic) { stt.track = stt.mic.getAudioTracks()[0].clone(); rec.start(stt.track); }
    else rec.start();
  } catch (e) {
    log(`rec.start(track) failed, using default mic WITHOUT echo control: ${e.message}`, 'warn');
    try { rec.start(); } catch (e2) { log(`rec.start failed: ${e2.message}`, 'err'); }
  }
}

function stopListening() {
  State.armed = false;
  clearTimeout(stt.silenceTimer);
  try { stt.rec && stt.rec.abort(); } catch {}
  stt.running = false;
}

/** Silence timer fired: close the mic and send what was heard. */
function commitUtterance() {
  const text = (stt.buf + ' ' + stt.interim).trim();
  stt.buf = ''; stt.interim = ''; el.interim.textContent = '';
  if (!text) return;
  log(`Silence ${CFG.SILENCE_MS} ms → sending: "${text.slice(0, 60)}"`);
  try { stt.rec && stt.rec.abort(); } catch {}   // mic closed while thinking; re-armed on first audio
  stt.running = false;
  sendToLLM(text);
}


/* =====================================================================
   10. CONTROLS
   ===================================================================== */

/* ---- 10a. Mic button: start talking / stop everything ---- */
el.mic.onclick = () => {
  getAudioCtx();                                  // unlock audio inside the user gesture
  if (State.armed || State.is('speaking', 'listening')) {
    stopListening(); cancelEverything('user stop'); State.set('idle');
    log('Stopped');
    return;
  }
  State.armed = true; stt.buf = ''; stt.interim = '';
  log('Talk pressed');
  startListening();
};

/* ---- 10b. Stop ---- */
el.stop.onclick = () => { stopListening(); cancelEverything('stop button'); State.set('idle'); };

/* ---- 10c. Re-arm toggle (turn off if barge-in misbehaves) ---- */
el.rearm.onclick = () => {
  State.rearm = !State.rearm;
  el.rearm.classList.toggle('on', State.rearm);
  el.rearm.textContent = `Re-arm: ${State.rearm ? 'On' : 'Off'}`;
  log(`Re-arm ${State.rearm ? 'ON' : 'OFF'}`, 'warn');
};

/* ---- 10d. Keyboard input ---- */
el.kbd.onclick = () => {
  const show = el.typed.style.display !== 'flex';
  el.typed.style.display = show ? 'flex' : 'none';
  el.kbd.classList.toggle('on', show);
  if (show) el.txt.focus();
};
function sendTyped() {
  const text = el.txt.value.trim();
  if (!text) return;
  el.txt.value = '';
  getAudioCtx();
  sendToLLM(text);
}
el.send.onclick = sendTyped;
el.txt.onkeydown = e => { if (e.key === 'Enter') sendTyped(); };

/* ---- 10e. Clear chat ---- */
el.clear.onclick = () => { el.chat.innerHTML = ''; run.history = []; log('Chat cleared'); };

/* ---- 10f. Echo test: play a line, stay silent, log whatever the mic picks up ----
   No "heard during playback" lines at the end = echo cancellation fully suppressed playback. */
el.echo.onclick = async () => {
  getAudioCtx(); stopListening(); cancelEverything();
  if (!await ensureMic()) return;

  const line = 'This is an echo test. If my own voice leaks into your microphone, you will see it in the log under heard during playback.';
  State.testMode = true; State.armed = true;
  run.spokenText = '';                            // empty on purpose: every heard word is reported as leakage
  stt.lastHeardLog = '';
  log('Echo test: playing a line; stay silent. Any "heard" lines mean leakage.', 'warn');
  State.set('thinking', 'Echo test…');

  speaker.reset();
  speaker.onFirstAudio = () => { run.speakingStart = performance.now(); State.set('speaking', 'Echo test'); startListening(); };
  speaker.onDone = () => {
    run.lastSpeechEnd = performance.now();
    setTimeout(() => {                            // wait out the echo tail, then report
      stopListening(); State.testMode = false; State.set('idle');
      log('Echo test finished. No "heard" lines = echo cancellation suppressed the playback.', 'ok');
    }, CFG.TAIL_MS);
  };
  speaker.push(line);
  speaker.end();
};

log('App ready', 'ok');