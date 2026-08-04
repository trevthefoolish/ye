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

function startMockXai(t, opts = {}) {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const payloads = [];
  const delayMs = opts.delayMs || 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const payload = JSON.parse(body);
      payloads.push(payload);
      const ref = payload.messages.find(m => m.role === 'user').content;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
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
      active--;
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        get calls() { return calls; },
        get maxActive() { return maxActive; },
        get payloads() { return payloads; },
      });
    });
  });
}

function startMockResponsesXai(t, opts = {}) {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const payloads = [];
  const delayMs = opts.delayMs || 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      const payload = JSON.parse(body);
      payloads.push(payload);
      const user = payload.input.find(m => m.role === 'user');
      const request = JSON.parse(user.content);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'resp_test',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              verses: request.targetReferences.map(ref => ({
                ref,
                rendering: `Rendered ${ref}`,
                note: `Margin ${ref}`,
                noteKind: 'literary',
                christConnection: 'none',
              })),
            }),
          }],
        }],
      }));
      active--;
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/responses`,
        get calls() { return calls; },
        get maxActive() { return maxActive; },
        get payloads() { return payloads; },
      });
    });
  });
}

function startApp(t, xaiUrl, extraEnv = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-test-'));
  const rendersDir = path.join(temp, 'renders');
  const logsDir = path.join(temp, 'logs');
  const port = 3200 + Math.floor(Math.random() * 1000);
  let output = '';
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
      RENDER_PIPELINE: 'verse-v1',
      RENDER_MODEL: 'grok-4.5',
      RENDER_REASONING_EFFORT: 'low',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed) child.kill('SIGTERM');
    fs.rmSync(temp, { recursive: true, force: true });
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not start: ' + output)), 8000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('"event":"server_started"')) {
        clearTimeout(timeout);
        resolve({ port, rendersDir, logsDir, child, getOutput: () => output });
      }
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.on('exit', code => reject(new Error(`server exited ${code}: ${output}`)));
  });
}

function serverLogs(app, event) {
  return app.getOutput()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(entry => entry?.source === 'server' && (!event || entry.event === event));
}

async function waitForServerLog(app, event, predicate = () => true) {
  for (let i = 0; i < 40; i++) {
    const found = serverLogs(app, event).find(predicate);
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server log not found: ${event}`);
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

  await t.test('favicon.ico redirects to the SVG favicon', async () => {
    const res = await request(app.port, '/favicon.ico');
    assert.equal(res.status, 301);
    assert.equal(res.headers.location, '/favicon.svg');
  });

  await t.test('version endpoint reports Grok 4.5 and low reasoning', async () => {
    const res = await request(app.port, '/api/version');
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.model, 'grok-4.5');
    assert.equal(data.reasoningEffort, 'low');
    assert.equal(data.appVersion, '0.0.1');
    assert.equal(typeof data.version, 'string');
  });

  await t.test('chapter pages inline partial cached verses for instant first paint', async () => {
    const versionRes = await request(app.port, '/api/version');
    const rv = JSON.parse(versionRes.body).version;
    const bible = require('../data/bible.json');
    const bookIndex = bible.books.indexOf('2 John');
    assert.ok(bookIndex >= 0);
    fs.writeFileSync(path.join(app.rendersDir, `${bookIndex}.json`), JSON.stringify({
      '0:0': { rendering: 'Partial seed verse', note: 'Partial seed note', v: rv, t: Date.now() },
    }));

    const res = await request(app.port, '/2-john/1');
    assert.equal(res.status, 200);
    assert.match(res.body, /<script id="preloaded" type="application\/json">/);
    assert.match(res.body, /Partial seed verse/);
    assert.match(res.body, /"complete":false/);
  });

  await t.test('cache-only chapter requests do not start background rendering', async () => {
    const before = mockXai.calls;
    const cold = await request(app.port, '/api/chapter/jude/1?render=0');
    assert.equal(cold.status, 200);
    const partial = JSON.parse(cold.body);
    assert.equal(partial.complete, false);
    assert.equal(partial.renderQueued, 'skipped');

    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(mockXai.calls, before);
  });

  await t.test('complete cached chapters keep ETag behavior after mock rendering', async () => {
    const cold = await request(app.port, '/api/chapter/ecclesiastes/1');
    assert.equal(cold.status, 200);
    assert.equal(JSON.parse(cold.body).complete, false);

    const complete = await waitForComplete(app.port, '/api/chapter/ecclesiastes/1');
    assert.equal(complete.complete, true);

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

    const payload = mockXai.payloads[0];
    assert.equal(payload.model, 'grok-4.5');
    assert.equal(payload.reasoning_effort, 'low');
    assert.equal(payload.store, false);
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

test('renderer v2 uses Responses API sections while preserving public chapter shape', async t => {
  const mockXai = await startMockResponsesXai(t, { delayMs: 5 });
  const app = await startApp(t, mockXai.url, {
    RENDER_PIPELINE: 'section-v2',
    SEED_RENDER_CACHE: '0',
  });

  const versionRes = await request(app.port, '/api/version');
  assert.equal(versionRes.status, 200);
  const version = JSON.parse(versionRes.body);
  assert.equal(version.model, 'grok-4.5');
  assert.equal(version.reasoningEffort, 'low');
  assert.equal(version.renderPipeline, 'section-v2');
  assert.equal(version.promptVersion, 'margin-note-v3');
  assert.equal(version.schemaVersion, 'section-render-v1');
  assert.equal(version.sectionVersion, 'sections-openbible-v1');

  const cold = await request(app.port, '/api/chapter/genesis/1');
  assert.equal(cold.status, 200);
  assert.equal(JSON.parse(cold.body).complete, false);

  const complete = await waitForComplete(app.port, '/api/chapter/genesis/1');
  assert.equal(complete.complete, true);
  assert.equal(complete.missingCount, 0);
  assert.ok(mockXai.calls > 0);

  const payload = mockXai.payloads[0];
  assert.equal(payload.model, 'grok-4.5');
  assert.equal(payload.store, false);
  assert.deepEqual(payload.reasoning, { effort: 'low' });
  assert.equal(payload.messages, undefined);
  assert.ok(Array.isArray(payload.input));
  assert.equal(payload.text.format.type, 'json_schema');
  assert.equal(payload.text.format.name, 'section_rendering');
  assert.equal(payload.text.format.strict, true);

  const user = JSON.parse(payload.input.find(m => m.role === 'user').content);
  assert.equal(user.book, 'Genesis');
  assert.equal(user.chapter, 1);
  assert.equal(user.targetVerses, undefined);
  assert.equal(user.section.startRef, 'Genesis 1:1');
  assert.equal(user.section.endRef, 'Genesis 2:3');
  assert.equal(user.section.source, 'openbible-consensus');
  assert.deepEqual(user.targetReferences.slice(0, 3), ['Genesis 1:1', 'Genesis 1:2', 'Genesis 1:3']);
  assert.deepEqual(user.targetReferences.slice(-3), ['Genesis 2:1', 'Genesis 2:2', 'Genesis 2:3']);
  assert.equal(user.genre, undefined);
  assert.equal(user.sectionKind, undefined);
  assert.equal(user.riskFlags, undefined);
  assert.equal(user.evalSets, undefined);
  assert.equal(user.section.genre, undefined);
  assert.equal(user.section.sectionKind, undefined);

  const cache = JSON.parse(fs.readFileSync(path.join(app.rendersDir, '0.json'), 'utf8'));
  assert.equal(cache['0:0'].rendering, 'Rendered Genesis 1:1');
  assert.equal(cache['0:0'].note, 'Margin Genesis 1:1');
  assert.equal(cache['0:0'].noteKind, 'literary');
  assert.equal(cache['0:0'].christConnection, 'none');
  assert.equal(cache['0:0'].v, version.version);
  assert.equal(cache['1:0'].rendering, 'Rendered Genesis 2:1');
  assert.equal(cache['1:0'].note, 'Margin Genesis 2:1');

  const publicChapter = await request(app.port, '/api/chapter/genesis/1');
  const publicData = JSON.parse(publicChapter.body);
  assert.equal(publicData.verses[0].rendering, 'Rendered Genesis 1:1');
  assert.equal(publicData.verses[0].note, 'Margin Genesis 1:1');
  assert.equal(publicData.verses[0].noteKind, undefined);
  assert.equal(publicData.verses[0].christConnection, undefined);
  assert.equal(publicData.verses[0].genre, undefined);
  assert.equal(publicData.verses[0].riskFlags, undefined);
});

test('renderer v2 dedupes overlapping chapter requests by section id', async t => {
  const mockXai = await startMockResponsesXai(t, { delayMs: 25 });
  const app = await startApp(t, mockXai.url, {
    RENDER_PIPELINE: 'section-v2',
    RENDER_CONCURRENCY: '4',
    SEED_RENDER_CACHE: '0',
  });

  const [genesis1, genesis2] = await Promise.all([
    request(app.port, '/api/chapter/genesis/1'),
    request(app.port, '/api/chapter/genesis/2'),
  ]);
  assert.equal(genesis1.status, 200);
  assert.equal(genesis2.status, 200);

  await Promise.all([
    waitForComplete(app.port, '/api/chapter/genesis/1'),
    waitForComplete(app.port, '/api/chapter/genesis/2'),
  ]);

  const renderedSections = mockXai.payloads.map(payload => {
    const user = JSON.parse(payload.input.find(m => m.role === 'user').content);
    return `${user.section.startRef}-${user.section.endRef}`;
  });
  assert.equal(
    renderedSections.filter(ref => ref === 'Genesis 1:1-Genesis 2:3').length,
    1
  );
});

test('global render concurrency caps upstream XAI calls without request rate limiting', async t => {
  const mockXai = await startMockXai(t, { delayMs: 25 });
  const app = await startApp(t, mockXai.url, { RENDER_CONCURRENCY: '2', SEED_RENDER_CACHE: '0' });
  const paths = [
    '/api/chapter/2-john/1',
    '/api/chapter/3-john/1',
    '/api/chapter/jude/1',
    '/api/chapter/philemon/1',
  ];

  const initial = await Promise.all(paths.map(p => request(app.port, p)));
  for (const res of initial) {
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.complete, false);
    assert.equal(data.retryAfterMs, 2000);
  }

  await Promise.all(paths.map(p => waitForComplete(app.port, p)));
  assert.ok(mockXai.calls > 0);
  assert.ok(mockXai.maxActive <= 2, `saw ${mockXai.maxActive} concurrent XAI calls`);
});

test('foreground chapter rendering outranks background adjacent pre-rendering', async t => {
  const mockXai = await startMockXai(t, { delayMs: 25 });
  const app = await startApp(t, mockXai.url, { RENDER_CONCURRENCY: '1', SEED_RENDER_CACHE: '0' });

  const background = await request(app.port, '/api/chapter/2-john/1?priority=background');
  assert.equal(background.status, 200);
  assert.equal(JSON.parse(background.body).renderPriority, 'background');

  const foreground = await request(app.port, '/api/chapter/3-john/1');
  assert.equal(foreground.status, 200);
  assert.equal(JSON.parse(foreground.body).renderPriority, 'foreground');

  await waitForComplete(app.port, '/api/chapter/3-john/1');

  const refs = mockXai.payloads.map(payload => payload.messages.find(m => m.role === 'user').content);
  const firstBackgroundAfterStart = refs.findIndex((ref, i) => i > 0 && ref.startsWith('2 John '));
  const lastForeground = refs.findLastIndex(ref => ref.startsWith('3 John '));

  assert.equal(refs[0], '2 John 1:1');
  assert.equal(refs[1], '3 John 1:1');
  assert.ok(
    firstBackgroundAfterStart === -1 || firstBackgroundAfterStart > lastForeground,
    `background resumed before foreground completed: ${refs.join(', ')}`
  );
});

test('foreground section-v2 rendering outranks background adjacent pre-rendering', async t => {
  const mockXai = await startMockResponsesXai(t, { delayMs: 25 });
  const app = await startApp(t, mockXai.url, {
    RENDER_PIPELINE: 'section-v2',
    RENDER_CONCURRENCY: '1',
    SEED_RENDER_CACHE: '0',
  });

  const background = await request(app.port, '/api/chapter/2-john/1?priority=background');
  assert.equal(background.status, 200);
  assert.equal(JSON.parse(background.body).renderPriority, 'background');

  const foreground = await request(app.port, '/api/chapter/3-john/1');
  assert.equal(foreground.status, 200);
  assert.equal(JSON.parse(foreground.body).renderPriority, 'foreground');

  await waitForComplete(app.port, '/api/chapter/3-john/1');

  const refs = mockXai.payloads.map(payload => {
    const user = JSON.parse(payload.input.find(m => m.role === 'user').content);
    return user.section.startRef;
  });
  const firstBackgroundAfterStart = refs.findIndex((ref, i) => i > 0 && ref.startsWith('2 John '));
  const lastForeground = refs.findLastIndex(ref => ref.startsWith('3 John '));

  assert.equal(refs[0], '2 John 1:1');
  assert.equal(refs[1], '3 John 1:1');
  assert.ok(
    firstBackgroundAfterStart === -1 || firstBackgroundAfterStart > lastForeground,
    `background resumed before foreground completed: ${refs.join(', ')}`
  );
});

test('chapter render logs timing summaries', async t => {
  const mockXai = await startMockXai(t, { delayMs: 25 });
  const app = await startApp(t, mockXai.url, { RENDER_CONCURRENCY: '2', SEED_RENDER_CACHE: '0' });

  const cold = await request(app.port, '/api/chapter/2-john/1');
  assert.equal(cold.status, 200);
  const partial = JSON.parse(cold.body);
  assert.equal(partial.complete, false);

  await waitForComplete(app.port, '/api/chapter/2-john/1');

  const started = await waitForServerLog(app, 'chapter_render_started', entry => entry.book === '2 John');
  assert.equal(started.ch, 1);
  assert.equal(started.missing, partial.missingCount);
  assert.equal(started.priority, 'foreground');
  assert.equal(started.renderConcurrency, 2);

  const finished = await waitForServerLog(app, 'chapter_render_finished', entry => entry.book === '2 John');
  assert.equal(finished.ch, 1);
  assert.equal(finished.rendered, partial.missingCount);
  assert.equal(finished.failed, 0);
  assert.equal(finished.missing, partial.missingCount);
  assert.ok(finished.batches > 0);
  assert.ok(finished.durationMs > 0);
  assert.ok(finished.avgVerseMs > 0);
  assert.ok(finished.p95VerseMs > 0);
  assert.ok(finished.maxVerseMs > 0);
  assert.ok(finished.avgQueueMs >= 0);
  assert.ok(finished.avgApiMs >= 20);
  assert.ok(finished.maxApiMs >= finished.avgApiMs);
});
