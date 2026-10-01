'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evalScenarios, evalSections, validateEvalScenarioData } = require('../src/render/section-eval');
const { buildUserPayload, sectionMap, sectionRef, sectionsForVerses, validateSectionMap, validateSectionResult } = require('../src/render/section-v2');

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('the committed section map covers every verse once, with bounded fallbacks', () => {
  const { data } = sectionMap();
  const validation = validateSectionMap(data);
  assert.equal(validation.verses, 31071);
  assert.equal(validation.expectedVerses, 31071);
  assert.ok(validation.sourceCounts['openbible-consensus'] > 0);
  assert.ok(validation.sourceCounts['generated-fallback'] > 0);
  for (const section of data.sections.filter(s => s.source === 'generated-fallback')) {
    const max = section.book === 'Psalms' ? 24 : section.book === 'Proverbs' ? 8 : 16;
    assert.ok(section.references.length <= max, `${section.id} exceeds fallback max`);
    assert.match(section.id, /^fallback-[a-z0-9-]+-\d+-\d+-\d+-\d+$/);
  }
});

test('validateSectionMap rejects gaps and overlaps', () => {
  const { data } = sectionMap();
  assert.throws(() => validateSectionMap({ ...data, sections: data.sections.slice(1) }), /uncovered refs/);
  assert.throws(() => validateSectionMap({ ...data, sections: [data.sections[0], ...data.sections] }), /duplicate section id/);
});

test('sectionsForVerses returns the covering sections in canonical order, including cross-chapter ones', () => {
  const sections = sectionsForVerses('Genesis', 2, range(1, 25));
  assert.equal(sectionRef(sections[0]), 'Genesis 1:1-Genesis 2:3');
  assert.ok(sections.length > 1);
  assert.throws(() => sectionsForVerses('Nope', 1, [1]), /unknown book/);
  assert.throws(() => sectionsForVerses('Genesis', 51, [1]), /unknown chapter/);
});

test('eval sets select smoke, edge, and prod-sim sections', () => {
  const verseCount = sections => sections.reduce((n, s) => n + s.targetReferences.length, 0);
  const smoke = evalSections('smoke');
  const edge = evalSections('edge');
  const prodSim = evalSections('prod-sim');
  assert.equal(evalScenarios('smoke').length, 4);
  assert.equal(evalScenarios('edge').length, 24);
  assert.equal(evalScenarios('prod-sim').length, 7);
  assert.equal(smoke.length, 4);
  assert.equal(verseCount(smoke), 15);
  assert.equal(edge.length, 24);
  assert.equal(verseCount(edge), 171);
  assert.ok(prodSim.length > 25);
  assert.ok(verseCount(prodSim) > 300);
  assert.ok(edge.every(s => s.evalSet === 'edge'));
  assert.ok(edge.some(s => s.genre === 'apocalyptic'));
  assert.ok(edge.some(s => s.riskFlags.includes('hard_text')));
  assert.ok(prodSim.some(s => s.source === 'openbible-consensus'));
});

test('prod-sim scenarios hydrate through production section grouping', () => {
  const prodSim = evalSections('prod-sim');
  const psalm119 = prodSim.filter(s => s.scenarioId === 'prod_psalm_119_full_fallback');
  assert.deepEqual(
    psalm119.map(s => [s.id, s.source, s.targetReferences.length]),
    sectionsForVerses('Psalms', 119, range(1, 176)).map(s => [s.id, s.source, s.targetReferences.length])
  );
  assert.equal(Math.max(...psalm119.map(s => s.targetReferences.length)), 8);
  const proverbs = prodSim.filter(s => s.scenarioId === 'prod_proverbs_26_partial_crossing');
  assert.deepEqual(proverbs.map(s => [sectionRef(s), s.source, s.targetReferences.length]), [
    ['Proverbs 26:1-Proverbs 26:28', 'openbible-consensus', 28],
  ]);
});

test('eval metadata never reaches the model payload', () => {
  const section = evalSections('edge').find(s => s.book === 'Joshua');
  assert.equal(section.genre, 'narrative');
  assert.deepEqual(section.riskFlags, ['violence', 'judgment', 'hard_text']);
  const payload = buildUserPayload(section);
  for (const key of ['genre', 'sectionKind', 'riskFlags', 'evalSets', 'mode', 'scenarioId', 'targetVerses']) {
    assert.equal(payload[key], undefined, key);
    assert.equal(payload.section[key], undefined, `section.${key}`);
  }
  assert.deepEqual(payload.targetReferences, ['Joshua 6:20', 'Joshua 6:21']);
});

test('section results keep target refs, drop in-section extras, and reject the rest', () => {
  const section = {
    references: range(25, 48).map(n => `Psalms 119:${n}`),
    targetReferences: ['Psalms 119:25', 'Psalms 119:48'],
  };
  const verse = n => ({ ref: `Psalms 119:${n}`, rendering: `R${n}`, note: `N${n}`, noteKind: 'literary', christConnection: 'none' });
  assert.deepEqual(validateSectionResult({ verses: [verse(48), verse(26), verse(25)] }, section), [verse(25), verse(48)]);
  assert.throws(() => validateSectionResult({ verses: [verse(25), verse(49), verse(48)] }, section), /unexpected rendered ref/);
  assert.throws(() => validateSectionResult({ verses: [verse(25), verse(26)] }, section), /missing target refs/);
  assert.throws(() => validateSectionResult({ verses: [verse(25), verse(25), verse(48)] }, section), /duplicate rendered ref/);
  assert.throws(() => validateSectionResult({ verses: [{ ...verse(25), noteKind: 'sermon' }, verse(48)] }, section), /note kind/);
});

test('eval scenario validation reports structural errors', () => {
  const valid = (overrides = {}) => ({ id: 'valid', evalSets: ['smoke'], mode: 'explicit', book: 'Genesis', chapter: 1, start: 1, end: 2, ...overrides });
  const check = scenarios => validateEvalScenarioData({ version: 'test', scenarios });
  assert.equal(check([valid()]), true);
  assert.throws(() => check([valid({ book: 'Nope' })]), /unknown book/);
  assert.throws(() => check([valid({ start: 0 })]), /invalid range/);
  assert.throws(() => check([valid({ mode: 'bad' })]), /invalid mode/);
  assert.throws(() => check([valid(), valid()]), /duplicate eval scenario id/);
  assert.throws(() => check([valid({ evalSets: [] })]), /at least one eval set/);
  assert.throws(() => check([valid({ mode: 'fallback-partial', targetVerses: [1, 1] })]), /duplicate target verse/);
});
