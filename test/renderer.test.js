'use strict';

// Chapter orchestration with a fake pipeline: no HTTP, no xAI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryLogger } = require('../src/log');
const { createRenderer, BACKGROUND, FOREGROUND } = require('../src/render/renderer');
const { RenderStore } = require('../src/render/store');
const { sleep, tempDir, waitFor } = require('./helpers');

const RUTH_1 = { bookIndex: 7, book: 'Ruth', chapter: 1 };

// One unit per verse. `fail(verse)` makes that verse throw.
function fakePipeline({ delayMs = 5, fail = () => false } = {}) {
  const calls = [];
  return {
    calls,
    name: 'fake',
    version: 'v-test',
    unit: 'verse',
    plan({ bookIndex, book, chapter }, missing) {
      return missing.map(verse => ({
        key: `verse:${bookIndex}:${chapter}:${verse}`,
        refs: [{ bookIndex, chapter, verse }],
        logFields: { book, ch: chapter, verse },
        async render() {
          calls.push(verse);
          await sleep(delayMs);
          if (fail(verse)) throw Object.assign(new Error(`verse ${verse} failed`), { retryable: false });
          return [{ bookIndex, chapter, verse, rendering: `R${verse}`, note: `N${verse}` }];
        },
      }));
    },
  };
}

// One unit for the whole of Ruth 1 whose nth attempt runs attempts[n](put),
// the way a streaming passage call hands over verses before it settles.
function streamingPipeline(attempts) {
  let calls = 0;
  return {
    get calls() { return calls; },
    name: 'fake-stream',
    version: 'v-test',
    unit: 'passage',
    plan({ bookIndex, book, chapter }, missing) {
      const entry = (verse, text) => ({ bookIndex, chapter, verse, rendering: `${text} ${verse}`, note: `N${verse}` });
      return [{
        key: `passage:${bookIndex}:${chapter}`,
        refs: missing.map(verse => ({ bookIndex, chapter, verse })),
        logFields: { book, ch: chapter },
        render: (usage, put) => attempts[calls++]({ put, entry, missing }),
      }];
    },
  };
}

function setup(t, pipeline, concurrency = 2, retries = 0) {
  const log = memoryLogger();
  const store = new RenderStore({ dir: tempDir(t), version: pipeline.version, log });
  const renderer = createRenderer({ pipeline, store, log, concurrency, retries, retryBaseMs: 1 });
  const missing = () => store.chapter(RUTH_1).missing;
  const text = verse => store.chapter(RUTH_1).verses[verse - 1]?.rendering;
  return { log, store, renderer, missing, text };
}

test('renders missing verses progressively, top to bottom, and logs a summary', async t => {
  const pipeline = fakePipeline();
  const { log, renderer, missing } = setup(t, pipeline);
  assert.equal(renderer.request(RUTH_1, missing(), FOREGROUND), 'started');
  await waitFor(() => missing().length < 22 && missing().length > 0, { what: 'partial progress', intervalMs: 2 });
  await waitFor(() => missing().length === 0, { what: 'chapter complete' });
  assert.deepEqual(pipeline.calls, Array.from({ length: 22 }, (_, i) => i + 1));

  const finished = await waitFor(() => log.entries.find(e => e.event === 'chapter_render_finished'));
  assert.equal(finished.rendered, 22);
  assert.equal(finished.failed, 0);
  for (const key of ['avgVerseMs', 'p95VerseMs', 'maxVerseMs', 'avgQueueMs', 'avgApiMs', 'maxApiMs']) {
    assert.equal(typeof finished[key], 'number', key);
  }
});

test('repeat requests join the in-flight job, promoting it when foreground', async t => {
  const { renderer, missing } = setup(t, fakePipeline());
  assert.equal(renderer.request(RUTH_1, missing(), BACKGROUND), 'started-background');
  assert.equal(renderer.request(RUTH_1, missing(), BACKGROUND), 'inflight');
  assert.equal(renderer.request(RUTH_1, missing(), FOREGROUND), 'promoted');
  assert.equal(renderer.request(RUTH_1, missing(), FOREGROUND), 'inflight');
  await waitFor(() => missing().length === 0);
});

test('failed verses stay missing and are retried by the next request', async t => {
  let broken = true;
  const pipeline = fakePipeline({ fail: verse => broken && verse === 3 });
  const { log, renderer, missing } = setup(t, pipeline);
  renderer.request(RUTH_1, missing(), FOREGROUND);
  const finished = await waitFor(() => log.entries.find(e => e.event === 'chapter_render_finished'));
  assert.equal(finished.failed, 1);
  assert.deepEqual(missing(), [3]);
  assert.ok(log.entries.some(e => e.event === 'verse_render_failed' && e.verse === 3 && e.reason === 'verse 3 failed'));

  broken = false;
  assert.equal(renderer.request(RUTH_1, missing(), FOREGROUND), 'started');
  await waitFor(() => missing().length === 0);
});

test('stores verses as they stream in, and a retry never rewrites one', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const pipeline = streamingPipeline([
    async ({ put, entry }) => {
      put([entry(1, 'First'), entry(2, 'First')]);
      await held;
      put([entry(3, 'First')]);
      throw new Error('stream broke');
    },
    // The retry renders the whole passage again for context.
    async ({ put, entry, missing }) => {
      put([entry(1, 'Second'), entry(4, 'Second')]);
      return missing.map(verse => entry(verse, 'Second'));
    },
  ]);
  const { log, renderer, missing, text } = setup(t, pipeline, 2, 1);
  renderer.request(RUTH_1, missing(), FOREGROUND);
  // Visible while the attempt is still running.
  await waitFor(() => text(2) === 'First 2', { what: 'streamed verses' });
  assert.equal(missing().length, 20);
  release();

  const finished = await waitFor(() => log.entries.find(e => e.event === 'chapter_render_finished'));
  assert.equal(pipeline.calls, 2);
  assert.deepEqual([1, 2, 3, 4, 5, 22].map(text), ['First 1', 'First 2', 'First 3', 'Second 4', 'Second 5', 'Second 22']);
  assert.equal(finished.rendered, 22);
  assert.equal(finished.failed, 0);
  assert.ok(log.entries.some(e => e.event === 'passage_render_retry' && e.reason === 'stream broke'));
});

test('a unit that fails partway counts only its unwritten verses as failed', async t => {
  const pipeline = streamingPipeline([
    async ({ put, entry }) => {
      put([entry(1, 'Kept'), entry(2, 'Kept')]);
      throw Object.assign(new Error('gave up'), { retryable: false });
    },
  ]);
  const { log, renderer, missing, text } = setup(t, pipeline);
  renderer.request(RUTH_1, missing(), FOREGROUND);
  const finished = await waitFor(() => log.entries.find(e => e.event === 'chapter_render_finished'));
  assert.equal(finished.rendered, 2);
  assert.equal(finished.failed, 20);
  assert.equal(text(1), 'Kept 1');
  assert.equal(missing().length, 20);
});

test('a retry makes no call when the failed attempt streamed every verse', async t => {
  const pipeline = streamingPipeline([
    async ({ put, entry, missing }) => {
      put(missing.map(verse => entry(verse, 'All')));
      throw new Error('verse 3 rendered twice');
    },
    async () => assert.fail('no second call'),
  ]);
  const { log, renderer, missing } = setup(t, pipeline, 2, 1);
  renderer.request(RUTH_1, missing(), FOREGROUND);
  const finished = await waitFor(() => log.entries.find(e => e.event === 'chapter_render_finished'));
  assert.equal(pipeline.calls, 1);
  assert.equal(finished.rendered, 22);
  assert.equal(finished.failed, 0);
});

test('skips the upstream call when another unit already filled the verse', async t => {
  const pipeline = fakePipeline();
  const { store, renderer } = setup(t, pipeline, 1);
  const planned = [1, 2];
  store.put([{ bookIndex: 7, chapter: 1, verse: 2, rendering: 'already', note: 'there' }]);
  renderer.request(RUTH_1, planned, FOREGROUND);
  await waitFor(() => store.has({ bookIndex: 7, chapter: 1, verse: 1 }));
  await sleep(20);
  assert.deepEqual(pipeline.calls, [1]);
});
