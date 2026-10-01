'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { memoryLogger } = require('../src/log');
const { RenderStore, mergeSeed } = require('../src/render/store');
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

test('mergeSeed folds in current seed entries and keeps everything else in the live file', () => {
  const merged = mergeSeed({
    '0:0': stored('Seeded'),
    '0:1': stored('Corrected'),
    '0:2': stored('Stale seed', OTHER),
    '0:3': { rendering: 'Missing note', v: VERSION },
    junk: stored('Bad key'),
  }, {
    '0:1': stored('Original'),
    '0:5': stored('Live only'),
  }, VERSION);
  assert.equal(merged.changed, true);
  assert.deepEqual(
    { added: merged.added, replaced: merged.replaced, skippedStale: merged.skippedStale, skippedMalformed: merged.skippedMalformed },
    { added: 1, replaced: 1, skippedStale: 1, skippedMalformed: 2 }
  );
  assert.deepEqual(Object.keys(merged.cache).sort(), ['0:0', '0:1', '0:5']);
  assert.equal(merged.cache['0:1'].rendering, 'Corrected');
});

test('mergeSeed leaves identical entries alone and counts a corrupt destination as replaced', () => {
  const same = { '0:0': stored('Same') };
  assert.equal(mergeSeed(same, structuredClone(same), VERSION).changed, false);
  const recovered = mergeSeed(same, {}, VERSION, { destCorrupt: true });
  assert.deepEqual([recovered.added, recovered.replaced], [0, 1]);
});

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
  for (let verse = 1; verse <= 22; verse++) writes.push(store.put([entry(verse, { ref: 'Ruth 1:1', noteKind: 'literary' })]));
  assert.equal(store.chapter(RUTH).missing.length, 0);
  assert.deepEqual(await Promise.all(writes), Array(22).fill([true]));
  const saved = readJson(path.join(dir, '7.json'));
  assert.equal(Object.keys(saved).length, 22);
  assert.deepEqual(Object.keys(saved['0:21']), ['rendering', 'note', 'noteKind', 'v', 't']);
  assert.equal(saved['0:21'].v, VERSION);
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

test('prepare() removes the pre-4.7 flat layout once and leaves other versions alone', t => {
  const { root, dir, log, store } = newStore(t);
  writeJson(path.join(root, '7.json'), { '0:0': stored('From grok-4.3', 'oldoldoldold') });
  writeJson(path.join(root, '19.json.1234.5678.abc.tmp'), 'partial');
  writeJson(path.join(root, '0.json.corrupt-1700000000000'), 'bad');
  writeJson(path.join(root, 'notes.txt'), 'not ours');
  writeJson(path.join(root, OTHER, '7.json'), { '0:0': stored('Another version', OTHER) });
  writeJson(path.join(dir, '7.json.99.abc.tmp'), 'partial');

  const result = store.prepare(null);
  assert.equal(result.legacyRemoved, 3);
  assert.deepEqual(result.otherVersions, [OTHER]);
  assert.deepEqual(fs.readdirSync(root).sort(), [VERSION, OTHER, 'notes.txt'].sort());
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(fs.existsSync(path.join(root, OTHER, '7.json')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_prepared' && e.legacyRemoved === 3));
  assert.equal(store.prepare(null).legacyRemoved, 0);
});

test('prepare() seeds this version from the committed renders and skips a bad seed file', t => {
  const seedRoot = tempDir(t);
  writeJson(path.join(seedRoot, VERSION, '7.json'), { '0:0': stored('Seeded'), '0:1': stored('Stale', OTHER) });
  writeJson(path.join(seedRoot, VERSION, '0.json'), '<<<<<<< conflict');
  writeJson(path.join(seedRoot, OTHER, '8.json'), { '0:0': stored('Not this version', OTHER) });
  const { dir, log, store } = newStore(t);
  writeJson(path.join(dir, '7.json'), { '0:5': stored('Live only') });

  const result = store.prepare(seedRoot);
  assert.deepEqual(
    { seededFiles: result.seededFiles, added: result.added, skippedStale: result.skippedStale },
    { seededFiles: 1, added: 1, skippedStale: 1 }
  );
  assert.deepEqual(Object.keys(readJson(path.join(dir, '7.json'))).sort(), ['0:0', '0:5']);
  assert.ok(!fs.existsSync(path.join(dir, '8.json')));
  assert.ok(log.entries.some(e => e.event === 'render_cache_seed_failed' && e.book === 0));
  assert.equal(store.prepare(seedRoot).seededFiles, 0);
});
