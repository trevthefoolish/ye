const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSeedRenderCache } = require('../renderCache');

test('seed merge replaces stale destination entries with current source entries', () => {
  const merged = mergeSeedRenderCache({
    '0:0': { rendering: 'Current rendering', note: 'Current note', v: 'current', t: 2 },
  }, {
    '0:0': { rendering: 'Old rendering', note: 'Old note', v: 'stale', t: 1 },
  }, 'current');

  assert.equal(merged.changed, true);
  assert.equal(merged.entriesAdded, 0);
  assert.equal(merged.entriesReplaced, 1);
  assert.equal(merged.entriesSkippedStaleSource, 0);
  assert.equal(merged.entriesSkippedMalformed, 0);
  assert.deepEqual(merged.cache['0:0'], { rendering: 'Current rendering', note: 'Current note', v: 'current', t: 2 });
});

test('seed merge skips stale source entries', () => {
  const dest = {
    '0:0': { rendering: 'Existing rendering', note: 'Existing note', v: 'old', t: 1 },
  };
  const merged = mergeSeedRenderCache({
    '0:0': { rendering: 'Stale source', note: 'Stale note', v: 'stale', t: 2 },
  }, dest, 'current');

  assert.equal(merged.changed, false);
  assert.equal(merged.entriesSkippedStaleSource, 1);
  assert.deepEqual(merged.cache, dest);
});

test('seed merge updates same-version changed source content', () => {
  const merged = mergeSeedRenderCache({
    '0:0': { rendering: 'Corrected rendering', note: 'Corrected note', v: 'current', t: 2 },
  }, {
    '0:0': { rendering: 'Original rendering', note: 'Original note', v: 'current', t: 1 },
  }, 'current');

  assert.equal(merged.changed, true);
  assert.equal(merged.entriesReplaced, 1);
  assert.deepEqual(merged.cache['0:0'], { rendering: 'Corrected rendering', note: 'Corrected note', v: 'current', t: 2 });
});

test('seed merge preserves destination-only entries and skips malformed source entries', () => {
  const merged = mergeSeedRenderCache({
    '0:0': { rendering: 'Current rendering', note: 'Current note', v: 'current', t: 2 },
    '0:2': { rendering: 'Missing note', v: 'current', t: 2 },
  }, {
    '0:1': { rendering: 'Destination only', note: 'Keep me', v: 'old', t: 1 },
  }, 'current');

  assert.equal(merged.changed, true);
  assert.equal(merged.entriesAdded, 1);
  assert.equal(merged.entriesSkippedMalformed, 1);
  assert.deepEqual(merged.cache['0:0'], { rendering: 'Current rendering', note: 'Current note', v: 'current', t: 2 });
  assert.deepEqual(merged.cache['0:1'], { rendering: 'Destination only', note: 'Keep me', v: 'old', t: 1 });
  assert.equal(merged.cache['0:2'], undefined);
});

test('seed merge counts current entries from a malformed destination file as replacements', () => {
  const merged = mergeSeedRenderCache({
    '0:0': { rendering: 'Recovered rendering', note: 'Recovered note', v: 'current', t: 2 },
  }, {}, 'current', { destFileMalformed: true });

  assert.equal(merged.changed, true);
  assert.equal(merged.entriesAdded, 0);
  assert.equal(merged.entriesReplaced, 1);
  assert.deepEqual(merged.cache['0:0'], { rendering: 'Recovered rendering', note: 'Recovered note', v: 'current', t: 2 });
});
