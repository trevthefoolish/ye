'use strict';

// Every cached verse is stamped with the render version that produced it, and
// the cache keeps only the running version. These pins catch any change (a
// refactor, a schema description tweak, a prompt edit) that would silently
// empty the cache and re-render, and re-bill, the entire Bible. If a change is
// intentional, update the pin in the same commit and say so in the PR.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { verseRenderVersion } = require('../src/render/verse-v1');
const { fingerprintSectionMap, sectionMap, sectionRenderVersion } = require('../src/render/section-v2');

const DEFAULTS = loadConfig({}).render;

test('defaults are Grok 4.7 at low reasoning effort', () => {
  assert.equal(DEFAULTS.model, 'grok-4.7');
  assert.equal(DEFAULTS.reasoningEffort, 'low');
});

test('verse-v1 render version is stable', () => {
  assert.equal(verseRenderVersion(DEFAULTS), '5155da19beec');
});

test('section-v2 render version is stable', () => {
  assert.equal(sectionMap().fingerprint, '358bcef46ba4');
  assert.equal(sectionRenderVersion(DEFAULTS), 'e226a3b91a43');
});

test('every input that shapes the output changes the version', () => {
  const base = verseRenderVersion(DEFAULTS);
  assert.notEqual(verseRenderVersion({ ...DEFAULTS, model: 'grok-4.7-0921' }), base);
  assert.notEqual(verseRenderVersion({ ...DEFAULTS, reasoningEffort: 'high' }), base);
  assert.notEqual(sectionRenderVersion({ ...DEFAULTS, reasoningEffort: 'high' }), sectionRenderVersion(DEFAULTS));
});

test('section map fingerprint tracks content, not generation time', () => {
  const { data } = sectionMap();
  assert.equal(
    fingerprintSectionMap({ ...data, generatedAt: '2000-01-01T00:00:00.000Z' }),
    fingerprintSectionMap({ ...data, generatedAt: '2030-01-01T00:00:00.000Z' })
  );
  const changed = { ...data, sections: [{ ...data.sections[0], label: 'Changed label' }, ...data.sections.slice(1)] };
  assert.notEqual(fingerprintSectionMap(changed), sectionMap().fingerprint);
});
