'use strict';

// End to end: a real server.js process against a mock xAI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getJson, request, startMockXai, startServer, waitFor, waitForComplete } = require('./helpers');

const BOOKS = require('../data/bible.json').books;
const bookFile = (app, version, book) => path.join(app.versionDir(version), `${BOOKS.indexOf(book)}.json`);
const readCache = (app, version, book) => JSON.parse(fs.readFileSync(bookFile(app, version, book), 'utf8'));
const writeCache = (app, version, book, data) => {
  fs.mkdirSync(app.versionDir(version), { recursive: true });
  fs.writeFileSync(bookFile(app, version, book), JSON.stringify(data));
};
const userContent = payload => payload.input.find(m => m.role === 'user').content;
const userRefs = mock => mock.payloads.map(userContent);
const sectionStarts = mock => mock.payloads.map(p => JSON.parse(userContent(p)).section.startRef);

test('verse-v1 server', async t => {
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
      version: '5155da19beec',
      model: 'grok-4.7',
      reasoningEffort: 'low',
      renderPipeline: 'verse-v1',
      promptVersion: 'verse-v1',
      schemaVersion: 'verse-v1',
      sectionVersion: null,
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
      '0:0': { rendering: 'Partial seed verse', note: 'Partial seed note', v: version, t: 1 },
    });
    const res = await request(app.port, '/2%20john/1');
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>2 John 1<\/title>/);
    assert.match(res.body, /<link rel="canonical" href="https:\/\/www\.vapourware\.ai\/2-john\/1">/);
    assert.match(res.body, /<meta name="description" content="Partial seed verse">/);
    const preloaded = JSON.parse(res.body.match(/<script id="preloaded" type="application\/json">(.*?)<\/script>/)[1]);
    assert.equal(preloaded.book, '2 John');
    assert.equal(preloaded.complete, false);
    assert.equal(preloaded.verses[0].rendering, 'Partial seed verse');
    const ld = JSON.parse(res.body.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
    assert.equal(ld.name, '2 John 1');
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

    const payload = mock.payloads.find(p => userContent(p) === 'Jude 1:1');
    assert.equal(payload.model, 'grok-4.7');
    assert.deepEqual(payload.reasoning, { effort: 'low' });
    assert.equal(payload.store, false);
    assert.equal(payload.messages, undefined);
    assert.equal(payload.input[0].role, 'system');
    assert.deepEqual(
      { type: payload.text.format.type, name: payload.text.format.name, strict: payload.text.format.strict },
      { type: 'json_schema', name: 'verse_rendering', strict: true }
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

  await t.test('logs a timing summary for each chapter render', async () => {
    const started = await app.waitForLog('chapter_render_started', e => e.book === 'Jude');
    assert.deepEqual(
      { ch: started.ch, missing: started.missing, priority: started.priority, renderConcurrency: started.renderConcurrency, units: started.units },
      { ch: 1, missing: 25, priority: 'foreground', renderConcurrency: 8, units: 25 }
    );
    const finished = await app.waitForLog('chapter_render_finished', e => e.book === 'Jude');
    assert.equal(finished.rendered, 25);
    assert.equal(finished.failed, 0);
    for (const key of ['durationMs', 'avgVerseMs', 'p95VerseMs', 'maxVerseMs', 'avgQueueMs', 'avgApiMs', 'maxApiMs']) {
      assert.equal(typeof finished[key], 'number', key);
    }
  });

  await t.test('stops cleanly on SIGTERM', async () => {
    app.child.kill('SIGTERM');
    const { code } = await app.exited;
    assert.equal(code, 0);
    assert.ok(app.logs('server_stopping').length === 1);
  });
});

test('startup removes the pre-4.7 cache layout once and leaves other render versions alone', async t => {
  const { tempDir } = require('./helpers');
  const { verseRenderVersion } = require('../src/render/verse-v1');
  const { loadConfig } = require('../src/config');
  const current = verseRenderVersion(loadConfig({}).render);
  const other = '0123456789ab';
  const volume = tempDir(t);
  const old = { '0:0': { rendering: 'From an older model', note: 'Old', v: '7fc357e1a8e6', t: 1 } };
  fs.writeFileSync(path.join(volume, '7.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(volume, '8.json'), JSON.stringify(old));
  fs.mkdirSync(path.join(volume, other));
  fs.writeFileSync(path.join(volume, other, '8.json'), JSON.stringify({ '0:0': { rendering: 'Another config', note: 'n', v: other, t: 1 } }));
  fs.mkdirSync(path.join(volume, current));
  fs.writeFileSync(path.join(volume, current, '7.json'), JSON.stringify({ '0:1': { rendering: 'Current verse', note: 'n', v: current, t: 1 } }));

  const mock = await startMockXai(t);
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDERS_DIR: volume });
  const prepared = await app.waitForLog('render_cache_prepared');
  assert.equal(prepared.legacyRemoved, 2);
  assert.deepEqual(prepared.otherVersions, [other]);
  assert.deepEqual(fs.readdirSync(volume).sort(), [current, other].sort());
  assert.ok(fs.existsSync(path.join(volume, other, '8.json')));

  const ruth = await getJson(app.port, '/api/chapter/ruth/1?render=0');
  assert.equal(ruth.verses[0], null);
  assert.equal(ruth.verses[1].rendering, 'Current verse');
  // Ruth 2 exists only in the removed legacy file and another version's
  // directory: its page must not borrow either's text.
  const page = (await request(app.port, '/ruth/2')).body;
  assert.match(page, /<meta name="description" content="Ruth 2, rendered in modern English with scholarly notes\.">/);
  assert.ok(!page.includes('id="preloaded"'));
});

test('upstream render concurrency is capped globally', async t => {
  const mock = await startMockXai(t, { delayMs: 25 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '2' });
  const paths = ['2-john', '3-john', 'jude', 'philemon'].map(book => `/api/chapter/${book}/1`);
  for (const data of await Promise.all(paths.map(p => getJson(app.port, p)))) assert.equal(data.complete, false);
  await Promise.all(paths.map(p => waitForComplete(app.port, p)));
  assert.equal(mock.maxActive, 2);
});

test('verse-v1: foreground chapters render before background prefetches', async t => {
  const mock = await startMockXai(t, { delayMs: 25 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '1' });

  assert.equal((await getJson(app.port, '/api/chapter/2-john/1?priority=background')).renderPriority, 'background');
  assert.equal((await getJson(app.port, '/api/chapter/3-john/1')).renderPriority, 'foreground');
  await waitForComplete(app.port, '/api/chapter/3-john/1');

  const refs = userRefs(mock);
  const thirdJohn = require('../data/bible.json').verses[BOOKS.indexOf('3 John')][0];
  // 2 John 1:1 was already running; everything else waited for 3 John.
  assert.deepEqual(refs.slice(0, 1 + thirdJohn), ['2 John 1:1', ...Array.from({ length: thirdJohn }, (_, i) => `3 John 1:${i + 1}`)]);
});

test('verse-v1: the chapter requested most recently renders first', async t => {
  const mock = await startMockXai(t, { delayMs: 20 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_CONCURRENCY: '1' });
  await getJson(app.port, '/api/chapter/ruth/1');
  await getJson(app.port, '/api/chapter/jude/1');
  await waitForComplete(app.port, '/api/chapter/jude/1');
  const refs = userRefs(mock);
  const lastJude = refs.lastIndexOf('Jude 1:25');
  assert.ok(refs.slice(0, lastJude).filter(r => r.startsWith('Ruth')).length <= 1, refs.slice(0, lastJude + 1).join(', '));
  // Within a chapter, verses go top to bottom.
  const jude = refs.filter(r => r.startsWith('Jude'));
  assert.deepEqual(jude, Array.from({ length: 25 }, (_, i) => `Jude 1:${i + 1}`));
});

test('section-v2 renders whole sections through the Responses API', async t => {
  const mock = await startMockXai(t, { delayMs: 5 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_PIPELINE: 'section-v2' });

  const info = await getJson(app.port, '/api/version');
  assert.equal(info.version, 'e226a3b91a43');
  assert.equal(info.renderPipeline, 'section-v2');
  assert.equal(info.promptVersion, 'margin-note-v3');
  assert.equal(info.schemaVersion, 'section-render-v1');
  assert.equal(info.sectionVersion, 'sections-openbible-v1');

  assert.equal((await getJson(app.port, '/api/chapter/genesis/1')).complete, false);
  const complete = await waitForComplete(app.port, '/api/chapter/genesis/1');
  // The public shape is the same as verse-v1: note metadata stays server-side.
  assert.deepEqual(complete.verses[0], { rendering: 'Rendered Genesis 1:1', note: 'Margin Genesis 1:1' });

  const payload = mock.payloads[0];
  assert.equal(payload.model, 'grok-4.7');
  assert.equal(payload.store, false);
  assert.deepEqual(payload.reasoning, { effort: 'low' });
  assert.equal(payload.messages, undefined);
  assert.deepEqual(
    { type: payload.text.format.type, name: payload.text.format.name, strict: payload.text.format.strict },
    { type: 'json_schema', name: 'section_rendering', strict: true }
  );
  const user = JSON.parse(payload.input.find(m => m.role === 'user').content);
  assert.equal(user.book, 'Genesis');
  assert.equal(user.chapter, 1);
  assert.deepEqual(user.section, { id: 'ob-gen-1-1-gen-2-3', startRef: 'Genesis 1:1', endRef: 'Genesis 2:3', label: 'Genesis 1:1-Genesis 2:3', source: 'openbible-consensus' });
  assert.deepEqual(user.targetReferences.slice(-2), ['Genesis 2:2', 'Genesis 2:3']);

  // One section call filled the start of chapter 2 as well.
  const cache = await waitFor(() => {
    try { const c = readCache(app, 'e226a3b91a43', 'Genesis'); return c['1:2'] && c; } catch { return null; }
  }, { what: 'Genesis cache file' });
  assert.deepEqual(cache['1:2'], { ...cache['1:2'], rendering: 'Rendered Genesis 2:3', noteKind: 'literary', christConnection: 'none', v: 'e226a3b91a43' });
});

test('section-v2 renders a section shared by two chapters once', async t => {
  const mock = await startMockXai(t, { delayMs: 25 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_PIPELINE: 'section-v2', RENDER_CONCURRENCY: '4' });
  await Promise.all([getJson(app.port, '/api/chapter/genesis/1'), getJson(app.port, '/api/chapter/genesis/2')]);
  await Promise.all([waitForComplete(app.port, '/api/chapter/genesis/1'), waitForComplete(app.port, '/api/chapter/genesis/2')]);
  assert.equal(sectionStarts(mock).filter(ref => ref === 'Genesis 1:1').length, 1);
});

test('section-v2: foreground chapters render before background prefetches', async t => {
  const mock = await startMockXai(t, { delayMs: 25 });
  const app = await startServer(t, { XAI_API_URL: mock.url, RENDER_PIPELINE: 'section-v2', RENDER_CONCURRENCY: '1' });
  await getJson(app.port, '/api/chapter/2-john/1?priority=background');
  await getJson(app.port, '/api/chapter/3-john/1');
  await waitForComplete(app.port, '/api/chapter/3-john/1');
  const starts = sectionStarts(mock);
  const lastForeground = starts.findLastIndex(ref => ref.startsWith('3 John'));
  assert.equal(starts[0], '2 John 1:1');
  assert.ok(!starts.slice(1, lastForeground).some(ref => ref.startsWith('2 John')), starts.join(', '));
});

test('upstream client errors are not retried; server errors are', async t => {
  let calls = 0;
  const mock = await startMockXai(t, {
    respond: payload => {
      const ref = userContent(payload);
      if (ref === 'Jude 1:1') return { status: 400, body: { code: 'Client specified an invalid argument', error: 'bad model' } };
      if (ref === 'Jude 1:2' && calls++ === 0) return { status: 503, body: {} };
      return null;
    },
  });
  const app = await startServer(t, { XAI_API_URL: mock.url });
  await getJson(app.port, '/api/chapter/jude/1');
  const finished = await waitFor(() => app.logs('chapter_render_finished')[0], { timeoutMs: 8000, what: 'render finish' });
  assert.equal(finished.failed, 1);
  const failure = app.logs('verse_render_failed')[0];
  assert.equal(failure.verse, 1);
  assert.equal(failure.attempts, 1);
  assert.equal(failure.reason, 'xAI HTTP 400: bad model');
  assert.ok(app.logs('verse_render_retry').some(e => e.verse === 2 && e.reason === 'xAI HTTP 503'));
  assert.deepEqual((await getJson(app.port, '/api/chapter/jude/1?render=0')).missingCount, 1);
});
