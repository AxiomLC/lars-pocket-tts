// Test3-Voice-AI-Pocket — one launcher. Serves UI, streams Groq LLM (SSE) and Pocket TTS (chunked WAV) to the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const E = process.env;
const PORT = +E.PORT || 1122;                                         // app port (set PORT in .env)
const POCKET_URL = E.POCKET_URL || 'http://localhost:1133/tts';        // Pocket TTS endpoint (set POCKET_URL in .env)
const POCKET_BASE = new URL(POCKET_URL).origin;

// ---- Pocket TTS: reuse it if it is already up, otherwise start it ----
// `child` is only set when WE started Pocket, so on exit we never stop a Pocket server that
// belongs to another app.
let child;
const pocketIsUp = async () => {
  try { return (await fetch(POCKET_BASE + '/health', { signal: AbortSignal.timeout(1500) })).ok; }
  catch { return false; }
};
(async () => {
  if (await pocketIsUp()) {
    console.log(`[pocket-tts] already running at ${POCKET_BASE}, reusing it (it will NOT be stopped on exit)`);
    return;
  }
  if (!E.POCKET_CMD) {
    console.log(`[pocket-tts] not running at ${POCKET_BASE} and POCKET_CMD is blank. Start it yourself.`);
    return;
  }
  child = spawn(E.POCKET_CMD, { shell: true, stdio: 'inherit' });
  child.on('exit', c => console.log(`[pocket-tts] exited (${c})`));
  console.log(`[pocket-tts] not running, started it: ${E.POCKET_CMD}`);
})();
// On Windows child.kill() only kills the cmd.exe shell, leaving Pocket TTS (python) holding the Pocket port,
// so kill the whole process tree with taskkill.
const bye = () => {
  try {
    if (child && process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child?.kill();
  } catch {}
  process.exit();
};
process.on('SIGINT', bye); process.on('SIGTERM', bye);

const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
const sendJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

// Pipe an upstream fetch Response body to the client; abort upstream if the client goes away (barge-in / stop).
function pipeThrough(req, res, upstream, headers) {
  res.writeHead(200, { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', ...headers });
  const s = Readable.fromWeb(upstream.body);
  s.on('error', () => res.end());
  s.pipe(res);
}

http.createServer(async (req, res) => {
  const ac = new AbortController();
  res.on('close', () => ac.abort());          // client disconnected -> cancel upstream work
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      let pocketUp = false;
      try { pocketUp = (await fetch(POCKET_BASE + '/health', { signal: AbortSignal.timeout(800) })).ok; } catch {}
      return sendJson(res, 200, {
        host: `${os.cpus()[0]?.model || '?'}, ${(os.totalmem() / 2 ** 30).toFixed(1)} GB RAM, node ${process.version}`,
        model: E.GROQ_MODEL || 'llama-3.1-8b-instant', keySet: !!E.GROQ_API_KEY,
        pocketUrl: POCKET_URL, voice: E.POCKET_VOICE || 'alba', pocketUp
      });
    }

    // ---- LLM: Groq streaming (SSE passthrough) ----
    if (req.method === 'POST' && req.url === '/api/chat') {
      const { messages } = JSON.parse(await readBody(req));
      const trimmed = messages.slice(-(+E.HISTORY_TURNS || 6) * 2);

      // >>> HERMES HOOK (commented placeholder) <<<
      // To route to a Hermes profile instead of Groq, replace the fetch below with e.g.:
      // const upstream = await fetch(process.env.HERMES_URL /* e.g. http://localhost:XXXX/chat */, {
      //   method: 'POST', signal: ac.signal,
      //   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.HERMES_TOKEN}` },
      //   body: JSON.stringify({ profile: process.env.HERMES_PROFILE, messages: trimmed, stream: true })
      // });
      // Hermes must return OpenAI-style SSE ("data: {choices:[{delta:{content}}]}") or adapt in the browser parser.
      // See AxiomLC/lars13 for the Hermes connection notes.

      if (!E.GROQ_API_KEY) return sendJson(res, 400, { error: 'Set GROQ_API_KEY in .env' });
      const upstream = await fetch(E.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${E.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: E.GROQ_MODEL || 'llama-3.1-8b-instant', stream: true, temperature: 0.6,
          max_tokens: +E.MAX_TOKENS || 200,
          messages: [{ role: 'system', content: E.SYSTEM_PROMPT || 'Reply briefly.' }, ...trimmed]
        })
      });
      if (!upstream.ok) return sendJson(res, upstream.status, { error: `Groq ${upstream.status}: ${(await upstream.text()).slice(0, 300)}` });
      return pipeThrough(req, res, upstream, { 'Content-Type': 'text/event-stream' });
    }

    // ---- TTS: Pocket TTS streaming (POST /tts, multipart form: text, voice_url -> chunked audio/wav) ----
    if (req.method === 'POST' && req.url === '/api/tts') {
      const { text } = JSON.parse(await readBody(req));
      const form = new FormData();
      form.append('text', text);
      if (E.POCKET_VOICE) form.append('voice_url', E.POCKET_VOICE);
      const upstream = await fetch(POCKET_URL, { method: 'POST', body: form, signal: ac.signal });
      if (!upstream.ok) return sendJson(res, 502, { error: `Pocket TTS ${upstream.status}: ${(await upstream.text()).slice(0, 200)}` });
      return pipeThrough(req, res, upstream, { 'Content-Type': 'audio/wav' });
    }

    // ---- static ----
    const f = path.join(__dir, 'public', req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!f.startsWith(path.join(__dir, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(f)] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e.name === 'AbortError' || res.headersSent) return res.end();
    const refused = /fetch failed|ECONNREFUSED/.test(String(e) + String(e.cause));
    sendJson(res, 500, { error: refused ? 'Upstream not reachable (Pocket TTS still loading, or no internet for Groq?)' : e.message });
  }
}).listen(PORT, () => console.log(`Test3-Voice-AI-Pocket → http://localhost:${PORT}  (open in Chrome)`));
