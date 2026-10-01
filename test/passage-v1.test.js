'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VERSE_COUNTS } = require('../src/canon');
const { PASSAGE_MAX_VERSES, createPassagePipeline, itemScanner, passages, validatePassage } = require('../src/render/passage-v1');
const { sleep, sseResponse, sseStream } = require('./helpers');

const delta = text => ({ type: 'response.output_text.delta', delta: text });
const completed = text => ({
  type: 'response.completed',
  response: { output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
});
// A whole passage reply, streamed a few characters at a time.
const streamedReply = value => {
  const text = JSON.stringify(value);
  return sseResponse([...text.match(/[^]{1,6}/g).map(delta), completed(text)]);
};
const verse = (n, extra = {}) => ({ verse: n, rendering: `Rendering ${n}`, note: `Note ${n}`, ...extra });
const pipelineWith = fetchImpl => createPassagePipeline({
  apiUrl: 'http://xai.test', apiKey: 'k', model: 'grok-4.7', reasoningEffort: 'low', passageTimeoutMs: 1000, fetchImpl,
});
const ECCLESIASTES_1 = { bookIndex: 20, book: 'Ecclesiastes', chapter: 1 };

test('every chapter splits into contiguous, near-even passages of at most 10 verses', () => {
  assert.equal(PASSAGE_MAX_VERSES, 10);
  assert.deepEqual(passages(2), [[1, 2]]);
  assert.deepEqual(passages(10), [[1, 10]]);
  assert.deepEqual(passages(11), [[1, 6], [7, 11]]);
  assert.deepEqual(passages(22), [[1, 8], [9, 15], [16, 22]]);
  for (const count of new Set(VERSE_COUNTS.flat())) {
    const parts = passages(count);
    assert.equal(parts[0][0], 1);
    assert.equal(parts.at(-1)[1], count);
    const sizes = parts.map(([start, end]) => end - start + 1);
    assert.ok(Math.max(...sizes) <= PASSAGE_MAX_VERSES && Math.max(...sizes) - Math.min(...sizes) <= 1, `${count}: ${sizes}`);
    parts.slice(1).forEach(([start], i) => assert.equal(start, parts[i][1] + 1));
  }
});

test('a passage rendering must cover each verse exactly once', () => {
  assert.deepEqual(validatePassage({ verses: [verse(2), verse(1)] }, 1, 2).map(v => v.verse), [1, 2]);
  // Context verses outside the passage are ignored.
  assert.deepEqual(validatePassage({ verses: [verse(1), verse(2), verse(3)] }, 2, 3).map(v => v.verse), [2, 3]);
  assert.throws(() => validatePassage({ verses: [verse(1)] }, 1, 2), /missing verse 2/);
  assert.throws(() => validatePassage({ verses: [verse(1), verse(1), verse(2)] }, 1, 2), /verse 1 rendered twice/);
  assert.throws(() => validatePassage({ verses: [verse(1, { note: ' ' }), verse(2)] }, 1, 2), /malformed verse 1/);
  assert.throws(() => validatePassage({ verses: [verse(1, { rendering: 7 }), verse(2)] }, 1, 2), /malformed verse 1/);
  assert.throws(() => validatePassage({}, 1, 2), /malformed passage rendering/);
});

test('the item scanner yields each array element of the root object as soon as it closes', () => {
  const value = {
    verses: [
      { verse: 1, rendering: 'Braces { } [ ] and "quotes" inside text', note: 'a backslash \\ then \\" and \\\\' },
      { verse: 2, rendering: 'Unicode: vapour — ✓  ', note: 'nested', extra: { deep: [{ x: 1 }], list: [1, [2]] } },
      { verse: 3, rendering: '', note: '' },
    ],
  };
  const text = JSON.stringify(value);
  const closes = value.verses.map((_, i) => text.indexOf(JSON.stringify(value.verses[i])) + JSON.stringify(value.verses[i]).length);
  // Fed one character at a time, each item appears exactly when its last brace does.
  const scan = itemScanner();
  const seen = [];
  for (let end = 1; end <= text.length; end++) {
    for (const item of scan(text.slice(0, end))) seen.push({ end, item });
  }
  assert.deepEqual(seen, value.verses.map((item, i) => ({ end: closes[i], item })));

  // Fed all at once, the same items.
  assert.deepEqual(itemScanner()(text), value.verses);
  // Only elements of an array directly inside the root object count.
  assert.deepEqual(itemScanner()('{"a":{"b":[{"no":1}]},"c":[1,{"yes":2},"s",[{"no":3}]],"d":{"no":4}}'), [{ yes: 2 }]);
  assert.deepEqual(itemScanner()('[{"no":1}]'), []);
  // An item cut short yields nothing yet.
  assert.deepEqual(itemScanner()('{"verses":[{"verse":1,"rendering":"}'), []);
});

test('passage-v1 sends the bare passage with the prompt file, and stores only missing verses, cleaned', async () => {
  const sent = [];
  const pipeline = pipelineWith(async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    const [, start, end] = body.input[1].content.match(/:(\d+)-(\d+)$/).map(Number);
    const verses = [];
    for (let n = start; n <= end; n++) verses.push(verse(n, { rendering: `Vapor ${n}—all vapor.` }));
    return streamedReply({ verses });
  });
  assert.equal(pipeline.name, 'passage-v1');
  assert.equal(pipeline.unit, 'passage');

  // Ecclesiastes 1 (18 verses) is 1-9 and 10-18; 2 and 12 are missing.
  const units = pipeline.plan(ECCLESIASTES_1, [2, 12]);
  assert.deepEqual(units.map(u => u.key), ['passage:20:1:1-9', 'passage:20:1:10-18']);
  assert.deepEqual(units.map(u => u.refs), [[{ bookIndex: 20, chapter: 1, verse: 2 }], [{ bookIndex: 20, chapter: 1, verse: 12 }]]);
  assert.deepEqual(units[0].logFields, { book: 'Ecclesiastes', ch: 1, verses: '1-9' });

  const put = [];
  const entries = await units[0].render(undefined, batch => put.push(...batch));
  const expected = [{ bookIndex: 20, chapter: 1, verse: 2, rendering: 'Vapour 2, all vapour.', note: 'Note 2' }];
  assert.deepEqual(entries, expected);
  // The same verse, cleaned, was handed over while it streamed.
  assert.deepEqual(put, expected);
  assert.equal(sent[0].input[0].content, fs.readFileSync(path.join(__dirname, '..', 'prompts', 'passage-v1.md'), 'utf8').trim());
  assert.equal(sent[0].input[1].content, 'Ecclesiastes 1:1-9');
  assert.equal(sent[0].stream, true);
  assert.equal(sent[0].text.format.name, 'passage_rendering');
  assert.deepEqual(sent[0].text.format.schema.properties.verses.items.required, ['verse', 'rendering', 'note']);

  // Without a put callback, the resolved entries are all there is.
  assert.deepEqual(await units[0].render(), expected);

  // A chapter with nothing missing plans nothing.
  assert.deepEqual(pipeline.plan(ECCLESIASTES_1, []), []);
});

test('each verse is handed over as soon as it streams in, before the passage completes', async () => {
  const stream = sseStream();
  const [unit] = pipelineWith(async () => stream.response).plan(ECCLESIASTES_1, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const put = [];
  const done = unit.render(undefined, batch => put.push(...batch.map(entry => entry.verse)));
  const send = async text => { stream.push(delta(text)); await sleep(5); };

  const verses = Array.from({ length: 9 }, (_, i) => verse(i + 1));
  const items = verses.map(v => JSON.stringify(v));
  await send(`{"verses":[${items[0]}`);
  assert.deepEqual(put, [1]);
  // Half a verse is not a verse.
  await send(`,${items[1].slice(0, 20)}`);
  assert.deepEqual(put, [1]);
  await send(`${items[1].slice(20)},${items[2]}`);
  assert.deepEqual(put, [1, 2, 3]);
  await send(`,${items.slice(3).join(',')}]}`);
  assert.deepEqual(put, [1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const text = JSON.stringify({ verses });
  stream.push(completed(text));
  stream.end();
  assert.deepEqual((await done).map(entry => entry.verse), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(put, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

// Streams `verses` as Ecclesiastes 1:1-9's reply, with 1 already rendered and
// 12 (in the next passage) missing too. Resolves the verses handed to put
// while streaming, and the error if the passage failed.
async function streamPassage(verses) {
  const [unit] = pipelineWith(async () => streamedReply({ verses })).plan(ECCLESIASTES_1, [2, 3, 4, 5, 6, 7, 8, 9, 12]);
  const put = [];
  const error = await unit.render(undefined, batch => put.push(...batch.map(entry => entry.verse))).then(() => null, err => err.message);
  return { put, error };
}
const run = (from, to, extra = {}) => Array.from({ length: to - from + 1 }, (_, i) => verse(from + i, extra));

test('streamed verses are handed over in order, skipping other passages and verses not missing', async () => {
  // Verse 12 belongs to the next passage and 10 is beyond this one: both skipped, even mid-stream.
  assert.deepEqual(await streamPassage([verse(1), verse(12), verse(2), verse(10), ...run(3, 9)]), { put: [2, 3, 4, 5, 6, 7, 8, 9], error: null });
});

test('a gap, repeat, reordering, or malformed verse stops the handing over', async () => {
  // A gap: the rest waits for the whole-text check, which fails.
  assert.deepEqual(await streamPassage([...run(1, 3), ...run(5, 9)]),
    { put: [2, 3], error: 'passage rendering missing verse 4 (verses 1-3 had streamed in)' });
  // A repeat stops it at once, even though the copy itself is well-formed.
  assert.deepEqual(await streamPassage([...run(1, 3), verse(3, { rendering: 'Again' }), ...run(4, 9)]),
    { put: [2, 3], error: 'verse 3 rendered twice (verses 1-3 had streamed in)' });
  assert.deepEqual(await streamPassage([...run(1, 2), verse(3, { note: ' ' }), ...run(4, 9)]),
    { put: [2], error: 'malformed verse 3 (verses 1-2 had streamed in)' });
  // Out of order but complete: nothing streams after the swap, and the whole
  // passage still arrives at the end.
  const swapped = await streamPassage([verse(1), verse(3), verse(2), ...run(4, 9)]);
  assert.deepEqual(swapped, { put: [], error: null });
  // Numbered from the wrong verse: nothing is handed over.
  assert.deepEqual(await streamPassage(run(2, 10)), { put: [], error: 'passage rendering missing verse 1' });
});

test('nothing after the top-level object is read', () => {
  const scan = itemScanner();
  assert.deepEqual(scan('{"verses":[{"verse":1}]}'), [{ verse: 1 }]);
  assert.deepEqual(scan('{"verses":[{"verse":1}]}{"verses":[{"verse":2}]}'), []);
});

test('a stream that breaks keeps what it handed over and fails the passage', async () => {
  const stream = sseStream();
  const [unit] = pipelineWith(async () => stream.response).plan(ECCLESIASTES_1, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const put = [];
  const done = unit.render(undefined, batch => put.push(...batch.map(entry => entry.verse)));
  stream.push(delta(`{"verses":[${JSON.stringify(verse(1))},${JSON.stringify(verse(2))},{"verse":3,"rend`));
  await sleep(5);
  stream.fail(new TypeError('terminated'));
  await assert.rejects(done, err => err.message === 'xAI request failed: terminated' && err.retryable);
  assert.deepEqual(put, [1, 2]);
});

test('the prompt describes the job and leaves style to the model', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'passage-v1.md'), 'utf8');
  assert.ok(prompt.split(/\s+/).length < 120, 'keep the prompt short');
  assert.ok(!/\b(MUST|NEVER|ALWAYS|CRITICAL)\b/.test(prompt), 'no hard rules');
});
