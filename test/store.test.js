'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { memoryLogger } = require('../src/log');
const { RenderStore } = require('../src/render/store');
const { tempDir } = require('./helpers');

const VERSION = 'aaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbb';
const RUTH = { bookIndex: 7, book: 'Ruth', chapter: 1 }; // 22 verses
const entry = (verse, extra = {}) => ({ bookIndex: 7, chapter: 1, verse, rendering: `R${verse}`, note: `N${verse}`, ...extra });
const stored = (rendering, v = VERSION) => ({ rendering, note: 'n', v, t: 1 });
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
};
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function newStore(t, version = VERSION) {
  const root = tempDir(t);
  const log = memoryLogger();
  return { root, log, dir: path.join(root, version), store: new RenderStore({ dir: root, version, log }) };
}

test('reads and writes only the directory of its own render version', async t => {
  const { root, dir, store } = newStore(t);
  writeJson(path.join(dir, '7.json'), { '0:1': stored('Kept'), '0:2': stored('Wrong stamp', OTHER) });
  writeJson(path.join(root, OTHER, '7.json'), { '0:0': stored('Another version') });

  const { verses, missing } = store.chapter(RUTH);
  assert.equal(verses.length, 22);
  assert.equal(verses[0], null);
  assert.deepEqual(verses[1], { rendering: 'Kept', note: 'n' });
  assert.equal(verses[2], null);
  assert.equal(missing.length, 21);
  assert.deepEqual(missing.slice(0, 3), [1, 3, 4]);

  await store.put([entry(1)]);
  assert.deepEqual(readJson(path.join(root, OTHER, '7.json')), { '0:0': stored('Another version') });
  assert.equal(readJson(path.join(dir, '7.json'))['0:0'].rendering, 'R1');
});

test('put() is visible at once and persists only known fields with 0-based keys', async t => {
  const { dir, store } = newStore(t);
  const writes = [];
  for (let verse = 1; verse <= 22; verse++) writes.push(store.put([entry(verse, { ref: 'Ruth 1:1' })]));
  assert.equal(store.chapter(RUTH).missing.length, 0);
  assert.deepEqual(await Promise.all(writes), Array(22).fill([true]));
  const saved = readJson(path.join(dir, '7.json'));
  assert.equal(Object.keys(saved).length, 22);
  assert.deepEqual(Object.keys(saved['0:21']), ['rendering', 'note', 'v', 't']);
  assert.equal(saved['0:21'].v, VERSION);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0);
});

test('stored text is served in the current house style, without rewriting the file', t => {
  const { dir, store } = newStore(t);
  // As the earlier cleanText left a spaced em dash, and a dash ending a verse.
  const saved = { '0:0': stored('in all their work ,  this too is a gift.'), '0:1': { ...stored('for women, '), note: 'a vapor note' } };
  writeJson(path.join(dir, '7.json'), saved);
  const { verses } = store.chapter(RUTH);
  assert.deepEqual(verses[0], { rendering: 'in all their work, this too is a gift.', note: 'n' });
  assert.deepEqual(verses[1], { rendering: 'for women,', note: 'a vapour note' });
  assert.deepEqual(readJson(path.join(dir, '7.json')), saved);
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

test('provisional verses are readable at once but never final, saved, or put over final text', async t => {
  const { dir, store } = newStore(t);
  await store.put([entry(1)]);
  store.stage([entry(1, { rendering: 'Over final' }), entry(2, { rendering: 'Draft 2' }), entry(3, { rendering: 'Draft 3' })]);
  const { verses, missing } = store.chapter(RUTH);
  assert.deepEqual(verses.slice(0, 4).map(v => v?.rendering ?? null), ['R1', 'Draft 2', 'Draft 3', null]);
  // Provisional verses still count as missing, so they are not final or complete.
  assert.deepEqual(missing.slice(0, 3), [2, 3, 4]);
  assert.equal(store.has({ bookIndex: 7, chapter: 1, verse: 2 }), false);
  store.stage(Array.from({ length: 22 }, (_, i) => entry(i + 1, { rendering: 'Draft' })));
  assert.equal(store.completeChapter(RUTH), null);

  // A later attempt may restage; put() replaces; unstage() drops.
  store.stage([entry(2, { rendering: 'Draft 2 again' })]);
  assert.equal(store.chapter(RUTH).verses[1].rendering, 'Draft 2 again');
  await store.put([entry(2)]);
  store.unstage([{ bookIndex: 7, chapter: 1, verse: 3 }]);
  assert.deepEqual(store.chapter(RUTH).verses.slice(0, 4).map(v => v?.rendering ?? null), ['R1', 'R2', null, 'Draft']);
  await store.flush();
  assert.deepEqual(Object.keys(readJson(path.join(dir, '7.json'))).sort(), ['0:0', '0:1']);
});

test('an unparseable cache file is moved aside instead of being overwritten', t => {
  const { dir, log, store } = newStore(t);
  writeJson(path.join(dir, '7.json'), '{ not json');
  assert.equal(store.chapter(RUTH).missing.length, 22);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('7.json.corrupt-')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_corrupt'));
});

test('a read error other than "missing" fails loudly and is retried, never written over', async t => {
  const { dir, store } = newStore(t);
  fs.mkdirSync(path.join(dir, '7.json')); // reading it fails with EISDIR
  assert.throws(() => store.chapter(RUTH), /EISDIR/);
  assert.throws(() => store.put([entry(1)]), /EISDIR/);
  fs.rmdirSync(path.join(dir, '7.json'));
  writeJson(path.join(dir, '7.json'), { '0:1': stored('Recovered') });
  assert.equal(store.chapter(RUTH).verses[1].rendering, 'Recovered');
});

test('prepare() clears interrupted writes and reports, but keeps, other versions', t => {
  const { root, dir, log, store } = newStore(t);
  writeJson(path.join(dir, '7.json'), { '0:0': stored('Kept') });
  writeJson(path.join(dir, '7.json.99.abc.tmp'), 'partial');
  writeJson(path.join(root, OTHER, '7.json'), { '0:0': stored('Another version', OTHER) });

  assert.deepEqual(store.prepare().otherVersions, [OTHER]);
  assert.deepEqual(fs.readdirSync(dir), ['7.json']);
  assert.ok(fs.existsSync(path.join(root, OTHER, '7.json')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_prepared'));
});
