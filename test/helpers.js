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
function passageReply(passage) {
  const [, book, chapter, start, end] = passage.match(/^(.+) (\d+):(\d+)-(\d+)$/);
  const verses = [];
  for (let verse = Number(start); verse <= Number(end); verse++) {
    const ref = `${book} ${chapter}:${verse}`;
    verses.push({ verse, rendering: `Rendered ${ref}`, note: `Note for ${ref}` });
  }
  return { verses };
}

// Answers Responses API passage requests with deterministic text. Like
// grok-4.7, it puts a reasoning item before the message. `respond(payload)` may return { status, body } to override the reply.
function startMockXai(t, { delayMs = 0, respond } = {}) {
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
      if (delayMs) await sleep(delayMs);
      active--;
      const override = respond?.(payload);
      res.setHeader('Content-Type', 'application/json');
      if (override) {
        res.statusCode = override.status || 200;
        return res.end(JSON.stringify(override.body));
      }
      const reply = passageReply(payload.input.find(m => m.role === 'user').content);
      res.end(JSON.stringify({
        id: 'resp_test',
        output: [
          { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply) }] },
        ],
        usage: {
          input_tokens: 700,
          input_tokens_details: { cached_tokens: 600 },
          output_tokens: 300,
          output_tokens_details: { reasoning_tokens: 250 },
          total_tokens: 1000,
        },
      }));
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

module.exports = { ROOT, getJson, request, sleep, startMockXai, startServer, tempDir, waitFor, waitForComplete };
