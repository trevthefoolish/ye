'use strict';

// The render version names the cache directory the server reads and writes.
// These pins catch any change (a refactor, a schema description tweak, a prompt
// edit) that would silently switch production to a fresh, empty directory and
// re-render, and re-bill, the entire Bible. If a change is intentional, update
// the pin in the same commit and say so in the PR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { verseRenderVersion } = require('../src/render/verse-v1');
const { fingerprintSectionMap, sectionMap, sectionRenderVersion } = require('../src/render/section-v2');

const DEFAULTS = loadConfig({}).render;

test('defaults are Grok 4.7 at low reasoning effort on the Responses API', () => {
  assert.equal(DEFAULTS.model, 'grok-4.7');
  assert.equal(DEFAULTS.reasoningEffort, 'low');
  assert.equal(DEFAULTS.apiUrl, 'https://api.x.ai/v1/responses');
  assert.equal(loadConfig({ RENDER_PIPELINE: 'section-v2' }).render.apiUrl, 'https://api.x.ai/v1/responses');
  // Stray whitespace or blank values never make a different model (and cache).
  assert.equal(verseRenderVersion(loadConfig({ RENDER_MODEL: ' grok-4.7 ', RENDER_REASONING_EFFORT: '' }).render), verseRenderVersion(DEFAULTS));
});

test('the committed renders/ holds only a render version this code produces', () => {
  const dir = path.join(__dirname, '..', 'renders');
  const current = [verseRenderVersion(DEFAULTS), sectionRenderVersion(DEFAULTS)];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .gitkeep, .DS_Store
    assert.ok(entry.isDirectory() && current.includes(entry.name), `renders/${entry.name} is not a current render version; re-sync or delete it`);
  }
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
