// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Eval scenarios for the section pipeline (data/eval-scenarios.json). The
// metadata here (genre, risk flags, ...) is for report grouping only and is
// never sent to the model.
//
// Modes:
//   explicit          an exact verse range, rendered as its own section
//   fallback-chapter  every production section touching the chapter
//   fallback-partial  the production sections touching the listed verses

const SCENARIOS = require('../../data/eval-scenarios.json');
const { BOOKS, verseCount } = require('../canon');
const { hydrateSection, sectionsForVerses } = require('./section-v2');

const MODES = ['explicit', 'fallback-chapter', 'fallback-partial'];
const EVAL_SCENARIOS_VERSION = SCENARIOS.version || 'eval-scenarios-v1';

function validateEvalScenarioData(data = SCENARIOS) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.scenarios)) {
    throw new Error('eval scenarios must contain a scenarios array');
  }
  const ids = new Set();
  for (const s of data.scenarios) {
    if (!s || typeof s !== 'object') throw new Error('malformed eval scenario');
    if (typeof s.id !== 'string' || s.id.trim() === '') throw new Error('eval scenario missing id');
    if (ids.has(s.id)) throw new Error(`duplicate eval scenario id: ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.evalSets) || s.evalSets.length === 0) throw new Error(`eval scenario ${s.id} must declare at least one eval set`);
    if (!s.evalSets.every(set => typeof set === 'string' && set.trim() !== '')) throw new Error(`eval scenario ${s.id} has malformed eval sets`);
    if (!MODES.includes(s.mode)) throw new Error(`eval scenario ${s.id} has invalid mode: ${s.mode}`);
    if (!Number.isInteger(s.chapter) || s.chapter < 1) throw new Error(`eval scenario ${s.id} has invalid chapter`);
    const bookIndex = BOOKS.indexOf(s.book);
    if (bookIndex === -1) throw new Error(`unknown book: ${s.book}`);
    const verses = verseCount(bookIndex, s.chapter);
    if (!verses) throw new Error(`unknown chapter: ${s.book} ${s.chapter}`);

    if (s.mode === 'explicit') {
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) throw new Error(`eval scenario ${s.id} explicit mode requires start and end`);
      if (s.start < 1 || s.end < s.start || s.end > verses) throw new Error(`eval scenario ${s.id} has invalid range`);
    } else if (s.mode === 'fallback-partial') {
      if (!Array.isArray(s.targetVerses) || s.targetVerses.length === 0) throw new Error(`eval scenario ${s.id} fallback-partial mode requires targetVerses`);
      const seen = new Set();
      for (const v of s.targetVerses) {
        if (!Number.isInteger(v) || v < 1 || v > verses) throw new Error(`eval scenario ${s.id} has invalid target verse`);
        if (seen.has(v)) throw new Error(`eval scenario ${s.id} has duplicate target verse`);
        seen.add(v);
      }
    }
  }
  return true;
}

function withScenario(section, scenario, evalSet) {
  return {
    ...section,
    scenarioId: scenario.id,
    scenarioLabel: scenario.label || null,
    mode: scenario.mode,
    evalSet,
    evalSets: scenario.evalSets,
    genre: scenario.genre || null,
    sectionKind: scenario.sectionKind || null,
    riskFlags: Array.isArray(scenario.riskFlags) ? scenario.riskFlags : [],
  };
}

function scenarioSections(scenario, evalSet) {
  if (scenario.mode === 'explicit') {
    const { book, chapter, start, end } = scenario;
    return [withScenario(hydrateSection({
      book, chapter, start, end,
      label: scenario.label || `${book} ${chapter}:${start}-${end}`,
    }, 'explicit'), scenario, evalSet)];
  }
  const verses = scenario.mode === 'fallback-chapter'
    ? Array.from({ length: verseCount(BOOKS.indexOf(scenario.book), scenario.chapter) }, (_, i) => i + 1)
    : scenario.targetVerses;
  return sectionsForVerses(scenario.book, scenario.chapter, verses).map(section => withScenario(section, scenario, evalSet));
}

function evalScenarios(evalSet = 'smoke', data = SCENARIOS) {
  validateEvalScenarioData(data);
  return data.scenarios.filter(s => s.evalSets.includes(evalSet));
}

// Hydrated sections, with scenario metadata attached, for one eval set.
function evalSections(evalSet = 'smoke', data = SCENARIOS) {
  return evalScenarios(evalSet, data).flatMap(s => scenarioSections(s, evalSet));
}

module.exports = { EVAL_SCENARIOS_VERSION, evalScenarios, evalSections, validateEvalScenarioData };
