const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function request(port, pathname, opts = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: opts.method || 'GET',
      headers: opts.headers || {},
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        ms: Date.now() - start,
      }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function startMockXai(t) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls++;
      const payload = JSON.parse(body);
      const ref = payload.messages.find(m => m.role === 'user').content;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              rendering: `Rendered ${ref}`,
              note: `Note for ${ref}`,
            }),
          },
        }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        get calls() { return calls; },
      });
    });
  });
}

function startApp(t, xaiUrl) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-test-'));
  const rendersDir = path.join(temp, 'renders');
  const logsDir = path.join(temp, 'logs');
  const port = 3200 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      XAI_API_KEY: 'test-key',
      XAI_API_URL: xaiUrl,
      RENDERS_DIR: rendersDir,
      LOG_DIR: logsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  });

  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('server did not start: ' + output)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('"event":"server_started"')) {
        clearTimeout(timeout);
        resolve({ port, rendersDir, logsDir, child });
      }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${output}`)));
  });
}

async function waitForComplete(port, pathname) {
  for (let i = 0; i < 40; i++) {
    const res = await request(port, pathname);
    const data = JSON.parse(res.body);
    if (data.complete) return data;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('chapter did not complete');
}

test('server hardening and chapter rendering behavior', async t => {
  const mockXai = await startMockXai(t);
  const app = await startApp(t, mockXai.url);

  await t.test('production health includes HSTS', async () => {
    const res = await request(app.port, '/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  });

  await t.test('bad page inputs redirect to Ecclesiastes 1 without stack traces', async () => {
    const badCookie = await request(app.port, '/', { headers: { Cookie: 'lastPos=%E0%A4%A' } });
    assert.equal(badCookie.status, 302);
    assert.equal(badCookie.headers.location, '/ecclesiastes/1');

    const badEncoding = await request(app.port, '/%E0%A4%A');
    assert.equal(badEncoding.status, 302);
    assert.equal(badEncoding.headers.location, '/ecclesiastes/1');
  });

  await t.test('bad API inputs stay typed as API errors', async () => {
    const res = await request(app.port, '/api/chapter/ecclesiastes/1abc');
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid book or chapter' });

    const missingApi = await request(app.port, '/api/nope');
    assert.equal(missingApi.status, 404);
    assert.deepEqual(JSON.parse(missingApi.body), { error: 'not found' });
  });

  await t.test('missing assets stay 404 instead of redirecting', async () => {
    const res = await request(app.port, '/missing.js');
    assert.equal(res.status, 404);
  });

  await t.test('complete cached chapters keep ETag behavior and bypass render throttling', async () => {
    const first = await request(app.port, '/api/chapter/ecclesiastes/1');
    assert.equal(first.status, 200);
    const data = JSON.parse(first.body);
    assert.equal(data.complete, true);
    assert.equal(data.missingCount, 0);
    assert.ok(first.headers.etag);

    const cached = await request(app.port, '/api/chapter/ecclesiastes/1', {
      headers: { 'If-None-Match': first.headers.etag },
    });
    assert.equal(cached.status, 304);

    for (let i = 0; i < 35; i++) {
      const res = await request(app.port, '/api/chapter/ecclesiastes/1');
      assert.equal(res.status, 200);
    }
  });

  await t.test('cold chapters return partial data quickly and complete in background', async () => {
    const cold = await request(app.port, '/api/chapter/jude/1');
    assert.equal(cold.status, 200);
    assert.ok(cold.ms < 1000, `cold response took ${cold.ms}ms`);
    const partial = JSON.parse(cold.body);
    assert.equal(partial.complete, false);
    assert.ok(partial.missingCount > 0);
    assert.equal(typeof partial.retryAfterMs, 'number');

    const complete = await waitForComplete(app.port, '/api/chapter/jude/1');
    assert.equal(complete.complete, true);
    assert.ok(mockXai.calls > 0);

    const judeCache = JSON.parse(fs.readFileSync(path.join(app.rendersDir, '64.json'), 'utf8'));
    assert.ok(judeCache['0:0']);
  });
});
