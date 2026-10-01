'use strict';

// End to end: a real server.js process against a mock xAI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getJson, request, sleep, startMockXai, startServer, tempDir, waitFor, waitForComplete } = require('./helpers');

const BOOKS = require('../data/bible.json').books;
const bookFile = (app, version, book) => path.join(app.versionDir(version), `${BOOKS.indexOf(book)}.json`);
const readCache = (app, version, book) => JSON.parse(fs.readFileSync(bookFile(app, version, book), 'utf8'));
const writeCache = (app, version, book, data) => {
  fs.mkdirSync(app.versionDir(version), { recursive: true });
  fs.writeFileSync(bookFile(app, version, book), JSON.stringify(data));
};
const userContent = payload => payload.input.find(m => m.role === 'user').content;
const userRefs = mock => mock.payloads.map(userContent);

test('server (passage-v1)', async t => {
  const mock = await startMockXai(t);
  const app = await startServer(t, { XAI_API_URL: mock.url });
  const { version } = await getJson(app.port, '/api/version');

  await t.test('sends security headers, including HSTS in production', async () => {
    const res = await request(app.port, '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { status: 'ok', version: '0.0.1' });
    assert.equal(res.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(res.headers['content-security-policy'], /default-src 'self'; script-src 'self'/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });

  await t.test('reports the render configuration', async () => {
    const info = await getJson(app.port, '/api/version');
    assert.deepEqual(info, {
      version: 'cbb178136416',
      model: 'grok-4.7',
      reasoningEffort: 'low',
      renderPipeline: 'passage-v1',
      appVersion: '0.0.1',
    });
  });

  await t.test('redirects the root to the remembered chapter, else Ecclesiastes 1', async () => {
    const cases = [[undefined, '/ecclesiastes/1'], ['lastPos=7:2', '/ruth/3'], ['lastPos=7:9', '/ecclesiastes/1'], ['lastPos=%E0%A4%A', '/ecclesiastes/1']];
    for (const [cookie, location] of cases) {
      const res = await request(app.port, '/', { headers: cookie ? { Cookie: cookie } : {} });
      assert.equal(res.status, 302);
      assert.equal(res.headers.location, location, String(cookie));
    }
  });

  await t.test('sends bad page URLs to Ecclesiastes 1 and keeps file requests 404', async () => {
    for (const p of ['/%E0%A4%A', '/ruth', '/ruth/99', '/nope/1', '/ruth/1/extra']) {
      const res = await request(app.port, p);
      assert.equal(res.status, 302, p);
      assert.equal(res.headers.location, '/ecclesiastes/1', p);
    }
    // Build inputs live in client/, so none of them is reachable raw.
    for (const p of ['/missing.js', '/index.html', '/app.js', '/style.css', '/%69ndex.html']) {
      assert.equal((await request(app.port, p)).status, 404, p);
    }
    assert.equal((await request(app.port, '/manifest.json')).status, 200);
    const favicon = await request(app.port, '/favicon.ico');
    assert.equal(favicon.status, 301);
    assert.equal(favicon.headers.location, '/favicon.svg');
  });

  await t.test('keeps API errors typed as JSON', async () => {
    const invalid = await request(app.port, '/api/chapter/ecclesiastes/1abc');
    assert.equal(invalid.status, 400);
    assert.deepEqual(JSON.parse(invalid.body), { error: 'invalid book or chapter' });
    const unknown = await request(app.port, '/api/nope');
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.body), { error: 'not found' });
    const undecodable = await request(app.port, '/api/chapter/%E0%A4%A/1');
    assert.equal(undecodable.status, 400);
  });

  await t.test('serves robots.txt and a sitemap of every chapter', async () => {
    assert.match((await request(app.port, '/robots.txt')).body, /Sitemap: https:\/\/www\.vapourware\.ai\/sitemap\.xml/);
    const sitemap = (await request(app.port, '/sitemap.xml')).body;
    assert.equal(sitemap.match(/<loc>/g).length, 1 + 1189);
    assert.match(sitemap, /<loc>https:\/\/www\.vapourware\.ai\/song-of-solomon\/8<\/loc>/);
  });

  await t.test('serves the minified client under an immutable content-hashed URL', async () => {
    const page = await request(app.port, '/ruth/1');
    const [, scriptPath] = page.body.match(/<script src="(\/app\.[0-9a-f]{10}\.js)">/);
    assert.match(page.body, new RegExp(`<link rel="preload" href="${scriptPath.replace(/\./g, '\\.')}" as="script">`));
    const script = await request(app.port, scriptPath);
    assert.equal(script.status, 200);
    assert.equal(script.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(script.body, /^\/\*! Copyright/);
    assert.ok(app.logs('js_minified').length === 1 && app.logs('minify_failed').length === 0);
    assert.equal((await request(app.port, '/app.0000000000.js')).status, 404);
    assert.match(page.body, /<style>:root\{|<style>\/\* Copyright/);
  });

  await t.test('chapter pages carry metadata and inline whatever is rendered', async () => {
    writeCache(app, version, '2 John', {
      '0:0': { rendering: 'Partial verse', note: 'Partial note', v: version, t: 1 },
    });
    const res = await request(app.port, '/2%20john/1');
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>2 John 1<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/www\.vapourware\.ai\/2-john\/1">/);
    assert.match(res.body, /<meta name="description" content="Partial verse">/);
    const preloaded = JSON.parse(res.body.match(/<script id="preloaded" type="application\/json">(.*?)<\/script>/)[1]);
    assert.equal(preloaded.book, '2 John');
    assert.equal(preloaded.complete, false);
    assert.equal(preloaded.verses[0].rendering, 'Partial verse');
    const ld = JSON.parse(res.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    assert.equal(ld.name, '2 John 1');
  });

  await t.test('pages without current-version text never borrow another version\'s', async () => {
    writeCache(app, version, 'Obadiah', { '0:0': { rendering: 'Mis-stamped verse', note: 'n', v: 'stale-version', t: 1 } });
    writeCache(app, '5155da19beec', 'Obadiah', { '0:0': { rendering: 'Old-version verse', note: 'n', v: '5155da19beec', t: 1 } });
    const res = await request(app.port, '/obadiah/1');
    assert.match(res.body, /<meta name="description" content="Obadiah 1, rendered in modern English with scholarly notes\.">/);
    assert.ok(!res.body.includes('id="preloaded"'));
    for (const text of ['Mis-stamped verse', 'Old-version verse']) assert.ok(!res.body.includes(text), text);
  });

  await t.test('model text cannot break out of the page', async () => {
    const hostile = '</script><script>alert(1)</script> "quoted" $& $\' <!--';
    writeCache(app, version, 'Philemon', {
      '0:0': { rendering: hostile, note: hostile, v: version, t: 1 },
    });
    const res = await request(app.port, '/philemon/1');
    assert.ok(!res.body.includes('<script>alert(1)'));
    assert.match(res.body, /<meta name="description" content="&lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;quoted&quot; \$&amp; \$&#39; &lt;!--">/);
    const preloaded = JSON.parse(res.body.match(/<script id="preloaded" type="application\/json">(.*?)<\/script>/)[1]);
    assert.equal(preloaded.verses[0].note, hostile);
  });

  await t.test('render=0 reads without queueing any rendering', async () => {
    const before = mock.calls;
    const data = await getJson(app.port, '/api/chapter/jude/1?render=0');
    assert.equal(data.complete, false);
    assert.equal(data.renderQueued, 'skipped');
    assert.equal(data.renderPriority, 'none');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(mock.calls, before);
  });

  await t.test('cold chapters answer at once and complete in the background', async () => {
    const cold = await request(app.port, '/api/chapter/jude/1');
    assert.ok(cold.ms < 1000, `cold response took ${cold.ms}ms`);
    assert.equal(cold.headers['cache-control'], 'no-store');
    const partial = JSON.parse(cold.body);
    assert.equal(partial.complete, false);
    assert.equal(partial.missingCount, 25);
    assert.equal(partial.retryAfterMs, 2000);
    assert.equal(partial.renderQueued, 'started');
    assert.equal(partial.renderPriority, 'foreground');

    const complete = await waitForComplete(app.port, '/api/chapter/jude/1');
    assert.deepEqual(complete.verses[0], { rendering: 'Rendered Jude 1:1', note: 'Note for Jude 1:1' });
    const cache = await waitFor(() => {
      try { const c = readCache(app, version, 'Jude'); return Object.keys(c).length === 25 && c; } catch { return null; }
    }, { what: 'Jude cache file' });
    assert.equal(cache['0:24'].v, version);

    // Jude's 25 verses go out as three passages, each a single call.
    assert.deepEqual(userRefs(mock).filter(ref => ref.startsWith('Jude')).sort(), ['Jude 1:1-9', 'Jude 1:10-17', 'Jude 1:18-25']);
    const payload = mock.payloads.find(p => userContent(p) === 'Jude 1:1-9');
    assert.equal(payload.model, 'grok-4.7');
    assert.deepEqual(payload.reasoning, { effort: 'low' });
    assert.equal(payload.store, false);
    assert.equal(payload.stream, true);
    assert.equal(payload.messages, undefined);
    assert.equal(payload.input[0].role, 'system');
    assert.equal(payload.input[0].content, fs.readFileSync(path.join(__dirname, '..', 'prompts', 'passage-v1.md'), 'utf8').trim());
    assert.deepEqual(
      { type: payload.text.format.type, name: payload.text.format.name, strict: payload.text.format.strict },
      { type: 'json_schema', name: 'passage_rendering', strict: true }
    );
  });

  await t.test('complete chapters are cacheable with an ETag', async () => {
    const first = await request(app.port, '/api/chapter/jude/1');
    assert.equal(first.headers['cache-control'], 'public, max-age=86400');
    assert.ok(first.headers.etag);
    assert.deepEqual(Object.keys(JSON.parse(first.body)), ['verses', 'complete', 'missingCount']);
    const revalidated = await request(app.port, '/api/chapter/jude/1', { headers: { 'If-None-Match': first.headers.etag } });
    assert.equal(revalidated.status, 304);
  });

  await t.test('entries stamped with another render version are re-rendered, not served', async () => {
    writeCache(app, version, '3 John', {
      '0:0': { rendering: 'Old-version verse', note: 'Old-version note', v: 'stale-version', t: 1 },
    });
    const cold = await getJson(app.port, '/api/chapter/3-john/1');
    assert.equal(cold.verses[0], null);
    const complete = await waitForComplete(app.port, '/api/chapter/3-john/1');
    assert.equal(complete.verses[0].rendering, 'Rendered 3 John 1:1');
  });

  await t.test('accepts analytics beacons and client error reports', async () => {
    const json = { 'Content-Type': 'application/json' };
    const ev = await request(app.port, '/api/ev', { method: 'POST', headers: json, body: JSON.stringify({ type: 'view', book: 'Ruth', ch: 1, extra: 'dropped' }) });
    assert.equal(ev.status, 204);
    assert.match(ev.headers['set-cookie'][0], /^sid=[0-9a-f]{8}; Path=\/api\/ev; Max-Age=1800; HttpOnly; SameSite=Strict; Secure$/);
    assert.equal((await request(app.port, '/api/ev', { method: 'POST', headers: json, body: '{"type":"bogus"}' })).status, 400);
    assert.equal((await request(app.port, '/api/log', { method: 'POST', headers: json, body: '{"type":"onerror","msg":"boom"}' })).status, 204);
    const malformed = await request(app.port, '/api/log', { method: 'POST', headers: json, body: '{not json' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(JSON.parse(malformed.body), { error: 'bad request' });
    assert.ok(app.logs('client_error').some(e => e.msg === 'boom'));
  });

  await t.test('logs a timing and token summary for each chapter render', async () => {
    const started = await app.waitForLog('chapter_render_started', e => e.book === 'Jude');
    assert.deepEqual(
      { ch: started.ch, missing: started.missing, priority: started.priority, renderConcurrency: started.renderConcurrency, units: started.units },
      { ch: 1, missing: 25, priority: 'foreground', renderConcurrency: 32, units: 3 }
    );
    const finished = await app.waitForLog('chapter_render_finished', e => e.book === 'Jude');
    assert.equal(finished.rendered, 25);
    assert.equal(finished.failed, 0);
    for (const key of ['durationMs', 'avgPassageMs', 'p95PassageMs', 'maxPassageMs', 'avgQueueMs', 'avgApiMs', 'maxApiMs']) {
      assert.equal(typeof finished[key], 'number', key);
    }
    // Three calls' worth of the mock's per-call usage.
    assert.deepEqual(
      { inputTokens: finished.inputTokens, cachedTokens: finished.cachedTokens, outputTokens: finished.outputTokens, reasoningTokens: finished.reasoningTokens },
      { inputTokens: 3 * 700, cachedTokens: 3 * 600, outputTokens: 3 * 300, reasoningTokens: 3 * 250 }
    );
  });

  await t.test('stops cleanly on SIGTERM', async () => {
    app.child.kill('SIGTERM');
    const { code } = await app.exited;
    assert.equal(code, 0);
    assert.ok(app.logs('server_stopping').length === 1);
  });
});

test('on Railway, only XAI_API_KEY is needed: renders and logs go on the volume', async t => {
  const volume = tempDir(t);
  const mock = await startMockXai(t);
  const app = await startServer(t, { XAI_API_URL: mock.url, RAILWAY_VOLUME_MOUNT_PATH: volume, RENDERS_DIR: '', LOG_DIR: '' });
  const info = await getJson(app.port, '/api/version');
  assert.equal(info.renderPipeline, 'passage-v1');
  assert.equal(info.model, 'grok-4.7');

  await getJson(app.port, '/api/chapter/jude/1');
  await waitForComplete(app.port, '/api/chapter/jude/1');
  await waitFor(() => fs.existsSync(path.join(volume, 'renders', info.version, '64.json')), { what: 'Jude on the volume' });
  assert.deepEqual(fs.readdirSync(path.join(volume, 'renders')), [info.version]);
  assert.ok(fs.readdirSync(path.join(volume, 'logs', 'server')).some(f => f.endsWith('.jsonl')));
});

test('upstream render concurrency is capped globally', async t => {
  const mock = await startMockXai(t, { delayMs: 25 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '2' });
  const paths = ['2-john', '3-john', 'jude', 'philemon'].map(book => `/api/chapter/${book}/1`);
  for (const data of await Promise.all(paths.map(p => getJson(app.port, p)))) assert.equal(data.complete, false);
  await Promise.all(paths.map(p => waitForComplete(app.port, p)));
  assert.equal(mock.maxActive, 2);
});

test('foreground chapters render before background prefetches', async t => {
  const mock = await startMockXai(t, { delayMs: 100 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '1' });
  assert.equal((await getJson(app.port, '/api/chapter/2-john/1?priority=background')).renderPriority, 'background');
  assert.equal((await getJson(app.port, '/api/chapter/3-john/1')).renderPriority, 'foreground');
  // A plain poll would promote 2 John to foreground; render=0 only reads.
  await waitForComplete(app.port, '/api/chapter/2-john/1?render=0');
  // 2 John's first passage was already running; its second waited for 3 John.
  assert.deepEqual(userRefs(mock), ['2 John 1:1-7', '3 John 1:1-7', '3 John 1:8-14', '2 John 1:8-13']);
});

test('background prefetches start beside foreground chapters but leave the reserve free', async t => {
  const mock = await startMockXai(t, { delayMs: 1000 });
  // Eight slots keep four for foreground; background runs while fewer than four are busy.
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '8' });
  await getJson(app.port, '/api/chapter/3-john/1');
  await getJson(app.port, '/api/chapter/2-john/1?priority=background');
  await getJson(app.port, '/api/chapter/jude/1?priority=background');
  // 3 John's two passages, then 2 John's two beside them; Jude's would take the reserve.
  await waitFor(() => mock.calls === 4, { what: 'four calls in flight' });
  await sleep(150);
  assert.equal(mock.calls, 4);
  assert.deepEqual(userRefs(mock).slice(2), ['2 John 1:1-7', '2 John 1:8-13']);
  // A chapter the reader opens now still starts at once, in the reserve.
  await getJson(app.port, '/api/chapter/psalms/117');
  await waitFor(() => mock.calls === 5, { what: 'the foreground call' });
  assert.equal(userRefs(mock)[4], 'Psalms 117:1-2');
  assert.equal(mock.maxActive, 5);
  for (const p of ['3-john/1', '2-john/1', 'jude/1', 'psalms/117']) await waitForComplete(app.port, `/api/chapter/${p}?render=0`);
  assert.equal(mock.calls, 8);
});

test('verses appear as they stream, before their passage finishes', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const mock = await startMockXai(t, { beforeVerse: (payload, n) => (userContent(payload) === 'Jude 1:1-9' && n === 3 ? held : null) });
  const app = await startServer(t, { XAI_API_URL: mock.url });
  await getJson(app.port, '/api/chapter/jude/1');
  // Three verses have streamed; the first two are stored, and the third waits for the fourth.
  const partial = await waitFor(async () => {
    const data = await getJson(app.port, '/api/chapter/jude/1?render=0');
    return data.verses[1] && data.verses.slice(9).every(Boolean) ? data : null;
  }, { what: 'the first two verses and the other passages' });
  assert.deepEqual(partial.verses[0], { rendering: 'Rendered Jude 1:1', note: 'Note for Jude 1:1' });
  assert.deepEqual(partial.verses.slice(2, 9), [null, null, null, null, null, null, null]);
  assert.equal(partial.missingCount, 7);
  release();
  const complete = await waitForComplete(app.port, '/api/chapter/jude/1?render=0');
  assert.equal(complete.verses[8].rendering, 'Rendered Jude 1:9');
  assert.equal(mock.calls, 3);
});

test('a passage that fails partway keeps the verses it streamed; its retry fills only the rest', async t => {
  let attempts = 0;
  const mock = await startMockXai(t, {
    respond: payload => {
      if (userContent(payload) !== 'Jude 1:1-9') return null;
      return attempts++ === 0 ? { failAfter: 3 } : { prefix: 'Retried' };
    },
  });
  const app = await startServer(t, { XAI_API_URL: mock.url });
  await getJson(app.port, '/api/chapter/jude/1');
  const complete = await waitForComplete(app.port, '/api/chapter/jude/1?render=0');
  // Three verses streamed before the failure; the third was still waiting for the fourth.
  assert.deepEqual(complete.verses.slice(0, 9).map(v => v.rendering), [
    'Rendered Jude 1:1', 'Rendered Jude 1:2',
    'Retried Jude 1:3', 'Retried Jude 1:4', 'Retried Jude 1:5', 'Retried Jude 1:6', 'Retried Jude 1:7', 'Retried Jude 1:8', 'Retried Jude 1:9',
  ]);
  // The retry rendered the whole passage again, for context.
  assert.deepEqual(userRefs(mock).filter(ref => ref === 'Jude 1:1-9').length, 2);
  const retry = await app.waitForLog('passage_render_retry');
  assert.deepEqual([retry.reason, retry.storedVerses], ['xAI response failed: mock failure', [1, 2]]);
  const finished = await app.waitForLog('chapter_render_finished');
  assert.equal(finished.rendered, 25);
  assert.equal(finished.failed, 0);
  // Both attempts were billed.
  assert.equal(finished.inputTokens, 4 * 700);
});

test('upstream client errors are not retried; server errors are', async t => {
  let calls = 0;
  const mock = await startMockXai(t, {
    respond: payload => {
      const ref = userContent(payload);
      if (ref === 'Jude 1:1-9') return { status: 400, body: { code: 'Client specified an invalid argument', error: 'bad model' } };
      if (ref === 'Jude 1:10-17' && calls++ === 0) return { status: 503, body: {} };
      return null;
    },
  });
  const app = await startServer(t, { XAI_API_URL: mock.url });
  await getJson(app.port, '/api/chapter/jude/1');
  const finished = await waitFor(() => app.logs('chapter_render_finished')[0], { timeoutMs: 8000, what: 'render finish' });
  assert.equal(finished.failed, 9);
  const failure = app.logs('passage_render_failed')[0];
  assert.equal(failure.verses, '1-9');
  assert.equal(failure.attempts, 1);
  assert.equal(failure.reason, 'xAI HTTP 400: bad model');
  assert.ok(app.logs('passage_render_retry').some(e => e.verses === '10-17' && e.reason === 'xAI HTTP 503'));
  assert.deepEqual((await getJson(app.port, '/api/chapter/jude/1?render=0')).missingCount, 9);
});

test('passage-v1 renders only the missing verses of a partly rendered passage, with the whole passage as context', async t => {
  const mock = await startMockXai(t);
  const app = await startServer(t, { XAI_API_URL: mock.url });
  const { version } = await getJson(app.port, '/api/version');
  // Ruth 1 is 1-8, 9-15, 16-22; only 1:3 is missing from the first passage.
  const cached = {};
  for (let verse = 1; verse <= 22; verse++) {
    if (verse !== 3) cached[`0:${verse - 1}`] = { rendering: `Kept Ruth 1:${verse}`, note: 'Kept', v: version, t: 1 };
  }
  writeCache(app, version, 'Ruth', cached);
  assert.equal((await getJson(app.port, '/api/chapter/ruth/1')).missingCount, 1);
  const complete = await waitForComplete(app.port, '/api/chapter/ruth/1');
  assert.deepEqual(userRefs(mock), ['Ruth 1:1-8']);
  assert.equal(complete.verses[2].rendering, 'Rendered Ruth 1:3');
  // The neighbours a reader may already have on screen are unchanged.
  assert.equal(complete.verses[1].rendering, 'Kept Ruth 1:2');
  assert.equal(complete.verses[3].rendering, 'Kept Ruth 1:4');
});
