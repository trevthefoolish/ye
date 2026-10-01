'use strict';

// Shared test utilities: a mock xAI server, a real server.js child process,
// and small polling helpers.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(fn, { timeoutMs = 6000, intervalMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

// node:test runs after-hooks in registration order and skips the rest once
// one throws, so cleanup here must never throw: a failed delete would
// otherwise skip killing a spawned server and leave the run hanging.
function removeQuietly(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch { /* a leftover temp dir is harmless */ }
}

function tempDir(t, prefix = 'ye-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeQuietly(dir));
  return dir;
}

function request(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, ms: Date.now() - started }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const getJson = async (port, pathname) => JSON.parse((await request(port, pathname)).body);

// "Jude 1:1-9" -> every verse of the passage, with deterministic text.
function passageReply(passage, prefix = 'Rendered') {
  const [, book, chapter, start, end] = passage.match(/^(.+) (\d+):(\d+)-(\d+)$/);
  const verses = [];
  for (let verse = Number(start); verse <= Number(end); verse++) {
    const ref = `${book} ${chapter}:${verse}`;
    verses.push({ verse, rendering: `${prefix} ${ref}`, note: `Note for ${ref}` });
  }
  return { verses };
}

const MOCK_USAGE = {
  input_tokens: 700,
  input_tokens_details: { cached_tokens: 600 },
  output_tokens: 300,
  output_tokens_details: { reasoning_tokens: 250 },
  total_tokens: 1000,
};

// One server-sent event the way xAI sends them: an "event:" line, then the data.
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const sseBytes = event => new TextEncoder().encode(typeof event === 'string' ? event : sse(event.type, event));

// A fetch Response streaming `events` (Responses API events, or raw strings
// sent as they are) in pieces of `chunkSize` bytes, which split lines, JSON,
// and multi-byte characters.
function sseResponse(events, { chunkSize = 5 } = {}) {
  const bytes = new Uint8Array(events.flatMap(event => [...sseBytes(event)]));
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  }));
}

// A fetch Response whose stream the test feeds by hand: push(event) sends an
// event, end() closes the stream, and fail(err) breaks it.
function sseStream() {
  let controller;
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
  return {
    response,
    push: event => controller.enqueue(sseBytes(event)),
    end: () => controller.close(),
    fail: err => controller.error(err),
  };
}

// Answers Responses API passage requests with deterministic text, streamed as
// server-sent events in small deltas that split words and JSON tokens. Like
// grok-4.7, it puts a reasoning item before the message.
//
// respond(payload) may return { status, body } to answer with that HTTP
// status and JSON body instead, or { prefix, failAfter } to start each
// rendering with `prefix` and to fail the response (response.failed) after
// streaming `failAfter` verses. beforeVerse(payload, n) may return a promise
// to hold the stream before its nth verse (0-based).
function startMockXai(t, { delayMs = 0, respond, beforeVerse } = {}) {
  const payloads = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      if (req.method !== 'POST' || req.url !== '/v1/responses') {
        res.statusCode = 404;
        return res.end('{"code":"Not found","error":"unknown endpoint"}');
      }
      const payload = JSON.parse(body);
      payloads.push(payload);
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (delayMs) await sleep(delayMs);
        const override = respond?.(payload) || {};
        if (override.status) {
          res.statusCode = override.status;
          res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(override.body));
        }
        res.setHeader('Content-Type', 'text/event-stream');
        const reply = passageReply(payload.input.find(m => m.role === 'user').content, override.prefix);
        const reasoning = { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque' };
        const response = { id: 'resp_test', object: 'response', status: 'in_progress', output: [] };
        res.write(sse('response.created', { response }));
        res.write(sse('response.output_item.added', { output_index: 0, item: reasoning }));
        res.write(sse('response.output_item.done', { output_index: 0, item: reasoning }));
        res.write(': keep-alive\n\n');
        res.write(sse('response.output_item.added', { output_index: 1, item: { type: 'message', id: 'msg_test', role: 'assistant', content: [] } }));
        const delta = text => {
          for (let i = 0; i < text.length; i += 7) {
            res.write(sse('response.output_text.delta', { item_id: 'msg_test', output_index: 1, content_index: 0, delta: text.slice(i, i + 7) }));
          }
        };
        delta('{"verses":[');
        for (const [n, verse] of reply.verses.entries()) {
          await beforeVerse?.(payload, n);
          if (n === override.failAfter) {
            return res.end(sse('response.failed', { response: { ...response, status: 'failed', error: { code: 'server_error', message: 'mock failure' }, usage: MOCK_USAGE } }));
          }
          delta(`${n ? ',' : ''}${JSON.stringify(verse)}`);
        }
        delta(']}');
        const text = JSON.stringify(reply);
        const message = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        res.write(sse('response.output_text.done', { item_id: 'msg_test', output_index: 1, content_index: 0, text }));
        res.write(sse('response.output_item.done', { output_index: 1, item: message }));
        res.end(sse('response.completed', { response: { ...response, status: 'completed', output: [reasoning, message], usage: MOCK_USAGE } }));
      } finally {
        active--;
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${base}/v1/responses`,
        payloads,
        get calls() { return payloads.length; },
        get maxActive() { return maxActive; },
      });
    });
  });
}

// Spawns `node server.js` against the mock, with a throwaway cache root and
// log directory. Resolves once the server logs that it is listening.
// app.versionDir(version) is where that render version's book files live.
function startServer(t, env = {}) {
  // Not tempDir(): this one is removed only after the server has exited.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-test-'));
  const rendersDir = path.join(dir, 'renders');
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      NODE_ENV: 'production',
      XAI_API_KEY: 'test-key',
      RENDERS_DIR: rendersDir,
      LOG_DIR: path.join(dir, 'logs'),
      RENDER_MODEL: '',
      RENDER_REASONING_EFFORT: '',
      RAILWAY_VOLUME_MOUNT_PATH: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    removeQuietly(dir);
  });

  const logs = event => output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(entry => entry?.source === 'server' && (!event || entry.event === event));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk;
      const started = logs('server_started')[0];
      if (!started) return;
      clearTimeout(timer);
      resolve({
        port: started.port,
        rendersDir,
        versionDir: version => path.join(env.RENDERS_DIR || rendersDir, version),
        child,
        exited,
        logs,
        waitForLog: (event, match = () => true) => waitFor(() => logs(event).find(match), { what: `log ${event}` }),
      });
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('exit', code => reject(new Error(`server exited ${code}:\n${output}`)));
  });
}

async function waitForComplete(port, pathname) {
  return waitFor(async () => {
    const data = await getJson(port, pathname);
    return data.complete ? data : null;
  }, { what: `${pathname} to complete`, intervalMs: 100 });
}

module.exports = { getJson, request, sleep, sseResponse, sseStream, startMockXai, startServer, tempDir, waitFor, waitForComplete };
