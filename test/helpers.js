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

function tempDir(t, prefix = 'ye-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

// Answers Responses API requests for both pipelines with deterministic text:
// a plain reference (verse-v1) or a JSON section payload (section-v2). Like
// grok-4.7, it puts a reasoning item before the message. `respond(payload)`
// may return { status, body } to override the reply.
function startMockXai(t, { delayMs = 0, respond } = {}) {
  const payloads = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
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
      const user = payload.input.find(m => m.role === 'user').content;
      const reply = user.startsWith('{')
        ? { verses: JSON.parse(user).targetReferences.map(ref => ({ ref, rendering: `Rendered ${ref}`, note: `Margin ${ref}`, noteKind: 'literary', christConnection: 'none' })) }
        : { rendering: `Rendered ${user}`, note: `Note for ${user}` };
      res.end(JSON.stringify({
        id: 'resp_test',
        output: [
          { type: 'reasoning', id: 'rs_test', summary: [], encrypted_content: 'opaque' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(reply) }] },
        ],
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

// Spawns `node server.js` against the mock, with a throwaway cache and log
// directory. Resolves once the server logs that it is listening.
function startServer(t, env = {}) {
  const dir = tempDir(t);
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
      RENDER_PIPELINE: '',
      RENDER_MODEL: '',
      RENDER_REASONING_EFFORT: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

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
