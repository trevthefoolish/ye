'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { memoryLogger } = require('../src/log');
const { RenderStore, mergeSeed } = require('../src/render/store');
const { tempDir } = require('./helpers');

const RUTH = { bookIndex: 7, book: 'Ruth', chapter: 1 }; // 22 verses
const entry = (verse, extra = {}) => ({ bookIndex: 7, chapter: 1, verse, rendering: `R${verse}`, note: `N${verse}`, ...extra });
const readBook = (dir, bookIndex) => JSON.parse(fs.readFileSync(path.join(dir, `${bookIndex}.json`), 'utf8'));

function newStore(t, version = 'v-current') {
  const dir = tempDir(t);
  const log = memoryLogger();
  return { dir, log, store: new RenderStore({ dir, version, log }) };
}

test('mergeSeed keeps only the current version and folds in current seed entries', () => {
  const merged = mergeSeed({
    '0:0': { rendering: 'Current', note: 'Note', v: 'current', t: 2 },
    '0:1': { rendering: 'New', note: 'Note', v: 'current', t: 2 },
    '0:2': { rendering: 'Corrected', note: 'Note', v: 'current', t: 2 },
    '0:3': { rendering: 'Stale seed', note: 'Note', v: 'stale', t: 2 },
    '0:4': { rendering: 'Missing note', v: 'current', t: 2 },
  }, {
    '0:0': { rendering: 'Old', note: 'Old', v: 'stale', t: 1 },
    '0:2': { rendering: 'Original', note: 'Note', v: 'current', t: 1 },
    '0:5': { rendering: 'Live only', note: 'Keep', v: 'current', t: 1 },
    '0:6': { rendering: 'Live but stale', note: 'Drop', v: 'stale', t: 1 },
    junk: { rendering: 'Bad key', note: 'Drop', v: 'current', t: 1 },
  }, 'current');
  assert.equal(merged.changed, true);
  assert.deepEqual(
    { added: merged.added, replaced: merged.replaced, dropped: merged.dropped, skippedStale: merged.skippedStale, skippedMalformed: merged.skippedMalformed },
    { added: 2, replaced: 1, dropped: 3, skippedStale: 1, skippedMalformed: 1 }
  );
  assert.deepEqual(Object.keys(merged.cache).sort(), ['0:0', '0:1', '0:2', '0:5']);
  assert.equal(merged.cache['0:0'].rendering, 'Current');
  assert.equal(merged.cache['0:2'].rendering, 'Corrected');
});

test('mergeSeed leaves an already-current file alone and counts a corrupt destination as replaced', () => {
  const same = { '0:0': { rendering: 'Same', note: 'Same', v: 'current', t: 1 } };
  assert.equal(mergeSeed(same, structuredClone(same), 'current').changed, false);
  assert.equal(mergeSeed({}, structuredClone(same), 'current').changed, false);
  const recovered = mergeSeed(same, {}, 'current', { destCorrupt: true });
  assert.equal(recovered.added, 0);
  assert.equal(recovered.replaced, 1);
});

test('chapter() serves only current-version entries and lists missing verses 1-based', async t => {
  const { dir, store } = newStore(t);
  fs.writeFileSync(path.join(dir, '7.json'), JSON.stringify({
    '0:0': { rendering: 'Old', note: 'Old', v: 'v-old', t: 1 },
    '0:1': { rendering: 'Kept', note: 'Kept', v: 'v-current', t: 1 },
  }));
  const { verses, missing } = store.chapter(RUTH);
  assert.equal(verses.length, 22);
  assert.equal(verses[0], null);
  assert.deepEqual(verses[1], { rendering: 'Kept', note: 'Kept' });
  assert.equal(missing.length, 21);
  assert.deepEqual(missing.slice(0, 3), [1, 3, 4]);
  assert.equal(store.has({ bookIndex: 7, chapter: 1, verse: 2 }), true);
  assert.equal(store.has({ bookIndex: 7, chapter: 1, verse: 1 }), false);
});

test('entries from another version are gone from the file after the next write', async t => {
  const { dir, store } = newStore(t);
  fs.writeFileSync(path.join(dir, '7.json'), JSON.stringify({
    '0:0': { rendering: 'Old', note: 'Old', v: 'v-old', t: 1 },
    '3:0': { rendering: 'Old', note: 'Old', v: 'v-old', t: 1 },
  }));
  await store.put([entry(2)]);
  assert.deepEqual(Object.keys(readBook(dir, 7)), ['0:1']);
});

test('put() is visible at once and persists only known fields with 0-based keys', async t => {
  const { dir, store } = newStore(t);
  const writes = [];
  for (let verse = 1; verse <= 22; verse++) writes.push(store.put([entry(verse, { ref: 'Ruth 1:1', noteKind: 'literary' })]));
  assert.equal(store.chapter(RUTH).missing.length, 0);
  assert.deepEqual(await Promise.all(writes), Array(22).fill([true]));
  const saved = readBook(dir, 7);
  assert.equal(Object.keys(saved).length, 22);
  assert.deepEqual(Object.keys(saved['0:21']), ['rendering', 'note', 'noteKind', 'v', 't']);
  assert.equal(saved['0:21'].v, 'v-current');
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
});

test('completeChapter() memoizes the body and invalidates it on write', async t => {
  const { store } = newStore(t);
  await store.put(Array.from({ length: 21 }, (_, i) => entry(i + 1)));
  assert.equal(store.completeChapter(RUTH), null);
  await store.put([entry(22)]);
  const first = store.completeChapter(RUTH);
  assert.equal(JSON.parse(first.body).complete, true);
  assert.match(first.etag, /^"[0-9a-f]{16}"$/);
  assert.equal(store.completeChapter(RUTH), first);
  await store.put([entry(1, { rendering: 'Revised' })]);
  assert.notEqual(store.completeChapter(RUTH).etag, first.etag);
});

test('an unparseable cache file is moved aside instead of being overwritten', async t => {
  const { dir, log, store } = newStore(t);
  fs.writeFileSync(path.join(dir, '7.json'), '{ not json');
  assert.equal(store.chapter(RUTH).missing.length, 22);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('7.json.corrupt-')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_corrupt'));
});

test('prepare() compacts the cache to the current version and folds in the seed', async t => {
  const seedDir = tempDir(t);
  fs.writeFileSync(path.join(seedDir, '7.json'), JSON.stringify({
    '0:0': { rendering: 'Seeded', note: 'Seeded', v: 'v-current', t: 1 },
    '0:1': { rendering: 'Stale seed', note: 'Stale', v: 'v-old', t: 1 },
  }));
  fs.writeFileSync(path.join(seedDir, 'notes.txt'), 'ignored');
  const { dir, log, store } = newStore(t);
  fs.writeFileSync(path.join(dir, '0.json'), JSON.stringify({ '0:0': { rendering: 'Old', note: 'Old', v: 'v-old', t: 1 } }));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ '0:0': { rendering: 'Live', note: 'Live', v: 'v-current', t: 1 } }));
  fs.writeFileSync(path.join(dir, '7.json.123.abc.tmp'), 'partial write');

  const totals = store.prepare(seedDir);
  assert.deepEqual(totals, { files: 2, added: 1, replaced: 0, dropped: 1, skippedStale: 1, skippedMalformed: 0 });
  assert.deepEqual(readBook(dir, 0), {});
  assert.equal(readBook(dir, 1)['0:0'].rendering, 'Live');
  assert.equal(readBook(dir, 7)['0:0'].rendering, 'Seeded');
  assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_prepared' && e.dropped === 1));
  assert.equal(store.prepare(seedDir).files, 0);
  assert.equal(store.prepare(null).files, 0);
});
