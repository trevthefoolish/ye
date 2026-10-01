'use strict';

// Every cached verse is stamped with the render version that produced it, and
// only entries matching the running version are served. These pins catch any
// change (a refactor, a stray newline in a prompt file) that would silently
// re-render, and re-bill, the entire Bible. If a change is intentional, update
// the pin in the same commit and say so in the PR.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verseRenderVersion } = require('../src/render/verse-v1');
const { fingerprintSectionMap, sectionMap, sectionRenderVersion } = require('../src/render/section-v2');

test('verse-v1 render versions are stable', () => {
  // grok-4.20 produced the committed renders/; grok-4.3 the production volume
  // before Grok 4.5; grok-4.5 is the current default.
  assert.equal(verseRenderVersion('grok-4.20-0309-non-reasoning'), 'ff54612cf1f0');
  assert.equal(verseRenderVersion('grok-4.3'), '7fc357e1a8e6');
  assert.equal(verseRenderVersion('grok-4.5'), 'c9b549050987');
});

test('committed renders carry a verse-v1 version this code can still produce', () => {
  const versions = new Set();
  const dir = path.join(__dirname, '..', 'renders');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    for (const entry of Object.values(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')))) versions.add(entry.v);
  }
  assert.ok(versions.has(verseRenderVersion('grok-4.20-0309-non-reasoning')));
});

test('section-v2 render version is stable', () => {
  assert.equal(sectionMap().fingerprint, '358bcef46ba4');
  assert.equal(sectionRenderVersion({ model: 'grok-4.5', reasoningEffort: 'low' }), 'd3fafd000992');
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
