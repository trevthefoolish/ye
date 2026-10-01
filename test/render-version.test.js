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
const { passageRenderVersion } = require('../src/render/passage-v1');

const DEFAULTS = loadConfig({}).render;

test('defaults are Grok 4.7 at low reasoning effort on the Responses API', () => {
  assert.equal(DEFAULTS.model, 'grok-4.7');
  assert.equal(DEFAULTS.reasoningEffort, 'low');
  assert.equal(DEFAULTS.apiUrl, 'https://api.x.ai/v1/responses');
  // Stray whitespace or blank values never make a different model (and cache).
  assert.equal(passageRenderVersion(loadConfig({ RENDER_MODEL: ' grok-4.7 ', RENDER_REASONING_EFFORT: '' }).render), passageRenderVersion(DEFAULTS));
});

test('the committed renders/ holds only a render version this code produces', () => {
  const dir = path.join(__dirname, '..', 'renders');
  const current = [passageRenderVersion(DEFAULTS)];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .gitkeep, .DS_Store
    assert.ok(entry.isDirectory() && current.includes(entry.name), `renders/${entry.name} is not a current render version; re-sync or delete it`);
  }
});

test('passage-v1 render version is stable', () => {
  assert.equal(passageRenderVersion(DEFAULTS), 'cbb178136416');
});

test('every input that shapes the output changes the version', () => {
  assert.notEqual(passageRenderVersion({ ...DEFAULTS, model: 'grok-4.7-0921' }), passageRenderVersion(DEFAULTS));
  assert.notEqual(passageRenderVersion({ ...DEFAULTS, reasoningEffort: 'high' }), passageRenderVersion(DEFAULTS));
});
