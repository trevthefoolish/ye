'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VERSE_COUNTS } = require('../src/canon');
const { PASSAGE_MAX_VERSES, createPassagePipeline, passages, validatePassage } = require('../src/render/passage-v1');

const responsesBody = value => ({
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
  ],
});
const verse = (n, extra = {}) => ({ verse: n, rendering: `Rendering ${n}`, note: `Note ${n}`, ...extra });

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

test('passage-v1 sends the bare passage with the prompt file, and stores only missing verses, cleaned', async () => {
  const sent = [];
  const pipeline = createPassagePipeline({
    apiUrl: 'http://xai.test', apiKey: 'k', model: 'grok-4.7', reasoningEffort: 'low', passageTimeoutMs: 1000,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      const [, start, end] = body.input[1].content.match(/:(\d+)-(\d+)$/).map(Number);
      const verses = [];
      for (let n = start; n <= end; n++) verses.push(verse(n, { rendering: `Vapor ${n}—all vapor.` }));
      return new Response(JSON.stringify(responsesBody({ verses })));
    },
  });
  assert.equal(pipeline.name, 'passage-v1');
  assert.equal(pipeline.unit, 'passage');

  // Ecclesiastes 1 (18 verses) is 1-9 and 10-18; 2 and 12 are missing.
  const units = pipeline.plan({ bookIndex: 20, book: 'Ecclesiastes', chapter: 1 }, [2, 12]);
  assert.deepEqual(units.map(u => u.key), ['passage:20:1:1-9', 'passage:20:1:10-18']);
  assert.deepEqual(units.map(u => u.refs), [[{ bookIndex: 20, chapter: 1, verse: 2 }], [{ bookIndex: 20, chapter: 1, verse: 12 }]]);
  assert.deepEqual(units[0].logFields, { book: 'Ecclesiastes', ch: 1, verses: '1-9' });

  const entries = await units[0].render();
  assert.deepEqual(entries, [{ bookIndex: 20, chapter: 1, verse: 2, rendering: 'Vapour 2, all vapour.', note: 'Note 2' }]);
  assert.equal(sent[0].input[0].content, fs.readFileSync(path.join(__dirname, '..', 'prompts', 'passage-v1.md'), 'utf8').trim());
  assert.equal(sent[0].input[1].content, 'Ecclesiastes 1:1-9');
  assert.equal(sent[0].text.format.name, 'passage_rendering');
  assert.deepEqual(sent[0].text.format.schema.properties.verses.items.required, ['verse', 'rendering', 'note']);

  // A chapter with nothing missing plans nothing.
  assert.deepEqual(pipeline.plan({ bookIndex: 20, book: 'Ecclesiastes', chapter: 1 }, []), []);
});

test('the prompt describes the job and leaves style to the model', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', 'prompts', 'passage-v1.md'), 'utf8');
  assert.ok(prompt.split(/\s+/).length < 120, 'keep the prompt short');
  assert.ok(!/\b(MUST|NEVER|ALWAYS|CRITICAL)\b/.test(prompt), 'no hard rules');
});
