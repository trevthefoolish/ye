// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { books: BOOKS, verses: VERSES } = require('./data/bible.json');
const SECTIONS_DATA = require('./data/sections.json');
const EVAL_SCENARIOS_DATA = require('./data/eval-scenarios.json');
const { parsePositiveInt } = require('./utils');

const RENDER_PIPELINE_V2 = 'section-v2';
const V2_PROMPT_VERSION = 'margin-note-v3';
const V2_SCHEMA_VERSION = 'section-render-v1';
const V2_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'margin-note-v3.md'), 'utf8').trim();
const SECTIONS_VERSION = SECTIONS_DATA.version || 'sections-v1';
const EVAL_SCENARIOS_VERSION = EVAL_SCENARIOS_DATA.version || 'eval-scenarios-v1';
const EVAL_SCENARIO_MODES = ['explicit', 'fallback-chapter', 'fallback-partial'];
const SECTION_RENDER_TIMEOUT_MS = parsePositiveInt(process.env.RENDER_SECTION_TIMEOUT_MS, 90_000);
const SECTION_SOURCE_VALUES = new Set(['openbible-consensus', 'generated-fallback', 'manual', 'explicit']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sectionMapFingerprintInput(data) {
  if (!data || typeof data !== 'object') return data;
  const { generatedAt, ...stable } = data;
  return stable;
}

function fingerprintSectionMap(data = SECTIONS_DATA) {
  return crypto
    .createHash('sha256')
    .update(stableStringify(sectionMapFingerprintInput(data)))
    .digest('hex')
    .slice(0, 12);
}

const SECTIONS_FINGERPRINT = fingerprintSectionMap(SECTIONS_DATA);

const NOTE_KIND_VALUES = [
  'lexical',
  'literary',
  'ancient_context',
  'narrative',
  'canonical',
  'christ_pattern',
  'wisdom',
  'list_identity',
  'other',
];

const CHRIST_CONNECTION_VALUES = [
  'none',
  'subtle',
  'typological',
  'direct',
  'fulfilled',
];

const SECTION_RENDER_SCHEMA = {
  type: 'object',
  properties: {
    verses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'The canonical verse reference rendered in this entry, for example "Genesis 1:1".',
          },
          rendering: {
            type: 'string',
            description: 'A faithful, plain, literary modern English rendering of the verse.',
          },
          note: {
            type: 'string',
            description: 'One compact margin-note observation for this verse, usually 12 to 26 words in one or two short sentences.',
          },
          noteKind: {
            type: 'string',
            enum: NOTE_KIND_VALUES,
            description: 'The primary kind of observation used in the note.',
          },
          christConnection: {
            type: 'string',
            enum: CHRIST_CONNECTION_VALUES,
            description: 'How explicit the Christ-centered canonical connection is.',
          },
        },
        required: ['ref', 'rendering', 'note', 'noteKind', 'christConnection'],
        additionalProperties: false,
      },
    },
  },
  required: ['verses'],
  additionalProperties: false,
};

function refForEntry(book, chapter, verse) {
  return `${book} ${chapter}:${verse}`;
}

const REF_RE = /^(.*) (\d+):(\d+)$/;
const REF_TO_LOCATION = new Map();
const REF_TO_ORDINAL = new Map();
const ORDINAL_TO_REF = [];

for (const [bookIndex, book] of BOOKS.entries()) {
  for (let chapter = 1; chapter <= VERSES[bookIndex].length; chapter++) {
    for (let verse = 1; verse <= VERSES[bookIndex][chapter - 1]; verse++) {
      const ref = refForEntry(book, chapter, verse);
      const location = { ref, book, bookIndex, chapter, verse };
      REF_TO_LOCATION.set(ref, location);
      REF_TO_ORDINAL.set(ref, ORDINAL_TO_REF.length);
      ORDINAL_TO_REF.push(ref);
    }
  }
}

function parseRef(ref) {
  if (REF_TO_LOCATION.has(ref)) return REF_TO_LOCATION.get(ref);
  const match = REF_RE.exec(ref);
  if (!match) throw new Error(`malformed reference: ${ref}`);
  throw new Error(`unknown reference: ${ref}`);
}

function compareRefs(a, b) {
  return REF_TO_ORDINAL.get(a) - REF_TO_ORDINAL.get(b);
}

function refsForRange(startRef, endRef) {
  const start = REF_TO_ORDINAL.get(startRef);
  const end = REF_TO_ORDINAL.get(endRef);
  if (start === undefined || end === undefined || end < start) {
    throw new Error(`invalid section range: ${startRef}-${endRef}`);
  }
  return ORDINAL_TO_REF.slice(start, end + 1);
}

function targetVersesFor(section) {
  return Array.from({ length: section.end - section.start + 1 }, (_, i) => section.start + i);
}

function hydrateSectionRecord(section) {
  const references = Array.isArray(section.references) && section.references.length
    ? section.references
    : refsForRange(section.startRef, section.endRef);
  const first = parseRef(references[0]);
  const last = parseRef(references[references.length - 1]);
  const startRef = section.startRef || first.ref;
  const endRef = section.endRef || last.ref;
  return {
    ...section,
    id: section.id || sectionKey({ book: first.book, chapter: first.chapter, start: first.verse, end: last.verse }),
    source: section.source || 'manual',
    book: section.book || first.book,
    chapter: first.chapter,
    start: first.verse,
    end: last.verse,
    startRef,
    endRef,
    label: section.label || `${startRef}-${endRef}`,
    references,
    targetReferences: Array.isArray(section.targetReferences) && section.targetReferences.length
      ? section.targetReferences
      : references,
  };
}

function validateSectionMap(data = SECTIONS_DATA) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) {
    throw new Error('sections data must contain a sections array');
  }
  const seenIds = new Set();
  const covered = new Set();
  const sourceCounts = {};
  const hydratedSections = [];
  for (const raw of data.sections) {
    const section = hydrateSectionRecord(raw);
    if (seenIds.has(section.id)) throw new Error(`duplicate section id: ${section.id}`);
    if (!SECTION_SOURCE_VALUES.has(section.source)) throw new Error(`unknown section source: ${section.source}`);
    seenIds.add(section.id);
    sourceCounts[section.source] = (sourceCounts[section.source] || 0) + 1;
    for (const ref of section.references) {
      parseRef(ref);
      if (covered.has(ref)) throw new Error(`overlapping section ref: ${ref}`);
      covered.add(ref);
    }
    for (const ref of section.targetReferences) {
      if (!section.references.includes(ref)) throw new Error(`target ref outside section ${section.id}: ${ref}`);
    }
    hydratedSections.push(section);
  }
  const missingRefs = ORDINAL_TO_REF.filter(ref => !covered.has(ref));
  if (missingRefs.length > 0) {
    throw new Error(`section map has ${missingRefs.length} uncovered refs, first missing: ${missingRefs[0]}`);
  }
  return {
    sections: data.sections.length,
    verses: covered.size,
    expectedVerses: ORDINAL_TO_REF.length,
    sourceCounts,
    hydratedSections,
  };
}

// Validation hydrates every section already; reuse its output rather than
// hydrating all 3,000+ sections a second time at startup.
const HYDRATED_SECTIONS = validateSectionMap(SECTIONS_DATA).hydratedSections;
const SECTIONS_BY_REF = new Map();
for (const section of HYDRATED_SECTIONS) {
  for (const ref of section.references) {
    if (!SECTIONS_BY_REF.has(ref)) SECTIONS_BY_REF.set(ref, []);
    SECTIONS_BY_REF.get(ref).push(section);
  }
}

function sectionRef(section) {
  return `${section.startRef || refForEntry(section.book, section.chapter, section.start)}-${section.endRef || refForEntry(section.book, section.chapter, section.end)}`;
}

function sectionsForMissingRefs(bookName, chapter, missingZeroBased) {
  const sections = new Map();
  for (const missing of missingZeroBased) {
    const ref = refForEntry(bookName, chapter, missing + 1);
    for (const section of SECTIONS_BY_REF.get(ref) || []) sections.set(section.id, section);
  }
  return [...sections.values()].sort((a, b) => compareRefs(a.startRef, b.startRef) || compareRefs(a.endRef, b.endRef));
}

function hydrateEvalSection(section) {
  const startRef = section.startRef || refForEntry(section.book, section.chapter, section.start);
  const endRef = section.endRef || refForEntry(section.book, section.chapter, section.end);
  const references = section.references || refsForRange(startRef, endRef);
  return {
    ...section,
    source: section.source || 'explicit',
    id: section.id || sectionKey(section),
    startRef,
    endRef,
    references,
    targetReferences: section.targetReferences || references,
  };
}

function sectionKey(section) {
  return `${section.book}:${section.chapter}:${section.start}:${section.end}`;
}

function groupMissingVersesIntoSections(bookName, chapter, missingZeroBased) {
  validateBookChapter(bookName, chapter);
  return sectionsForMissingRefs(bookName, chapter, missingZeroBased);
}

function validateBookChapter(book, chapter) {
  const bookIndex = BOOKS.indexOf(book);
  if (bookIndex === -1) throw new Error(`unknown book: ${book}`);
  const verseCount = VERSES[bookIndex]?.[chapter - 1];
  if (!verseCount) throw new Error(`unknown chapter: ${book} ${chapter}`);
  return { bookIndex, verseCount };
}

function validateEvalScenarioData(data = EVAL_SCENARIOS_DATA) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.scenarios)) {
    throw new Error('eval scenarios must contain a scenarios array');
  }
  const ids = new Set();
  for (const scenario of data.scenarios) {
    if (!scenario || typeof scenario !== 'object') throw new Error('malformed eval scenario');
    if (typeof scenario.id !== 'string' || scenario.id.trim() === '') throw new Error('eval scenario missing id');
    if (ids.has(scenario.id)) throw new Error(`duplicate eval scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (!Array.isArray(scenario.evalSets) || scenario.evalSets.length === 0) {
      throw new Error(`eval scenario ${scenario.id} must declare at least one eval set`);
    }
    if (!scenario.evalSets.every(set => typeof set === 'string' && set.trim() !== '')) {
      throw new Error(`eval scenario ${scenario.id} has malformed eval sets`);
    }
    if (!EVAL_SCENARIO_MODES.includes(scenario.mode)) {
      throw new Error(`eval scenario ${scenario.id} has invalid mode: ${scenario.mode}`);
    }
    if (!Number.isInteger(scenario.chapter) || scenario.chapter < 1) {
      throw new Error(`eval scenario ${scenario.id} has invalid chapter`);
    }
    const { verseCount } = validateBookChapter(scenario.book, scenario.chapter);

    if (scenario.mode === 'explicit') {
      if (!Number.isInteger(scenario.start) || !Number.isInteger(scenario.end)) {
        throw new Error(`eval scenario ${scenario.id} explicit mode requires start and end`);
      }
      if (scenario.start < 1 || scenario.end < scenario.start || scenario.end > verseCount) {
        throw new Error(`eval scenario ${scenario.id} has invalid range`);
      }
    } else if (scenario.mode === 'fallback-partial') {
      if (!Array.isArray(scenario.targetVerses) || scenario.targetVerses.length === 0) {
        throw new Error(`eval scenario ${scenario.id} fallback-partial mode requires targetVerses`);
      }
      const seen = new Set();
      for (const verse of scenario.targetVerses) {
        if (!Number.isInteger(verse) || verse < 1 || verse > verseCount) {
          throw new Error(`eval scenario ${scenario.id} has invalid target verse`);
        }
        if (seen.has(verse)) throw new Error(`eval scenario ${scenario.id} has duplicate target verse`);
        seen.add(verse);
      }
    }
  }
  return true;
}

function applyEvalMetadata(section, scenario, evalSet) {
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

function hydrateExplicitScenario(scenario, evalSet) {
  return applyEvalMetadata(hydrateEvalSection({
    book: scenario.book,
    chapter: scenario.chapter,
    start: scenario.start,
    end: scenario.end,
    label: scenario.label || `${scenario.book} ${scenario.chapter}:${scenario.start}-${scenario.end}`,
    source: 'explicit',
  }), scenario, evalSet);
}

function hydrateFallbackScenario(scenario, evalSet) {
  const { verseCount } = validateBookChapter(scenario.book, scenario.chapter);
  const targetVerses = scenario.mode === 'fallback-chapter'
    ? targetVersesFor({ start: 1, end: verseCount })
    : scenario.targetVerses;
  const missingZeroBased = targetVerses.map(verse => verse - 1);
  return groupMissingVersesIntoSections(scenario.book, scenario.chapter, missingZeroBased)
    .map(section => applyEvalMetadata(section, scenario, evalSet));
}

function evalSections(evalSet = 'smoke', data = EVAL_SCENARIOS_DATA) {
  validateEvalScenarioData(data);
  return data.scenarios
    .filter(scenario => scenario.evalSets.includes(evalSet))
    .flatMap(scenario => scenario.mode === 'explicit'
      ? [hydrateExplicitScenario(scenario, evalSet)]
      : hydrateFallbackScenario(scenario, evalSet));
}

function evalScenarios(evalSet = 'smoke', data = EVAL_SCENARIOS_DATA) {
  validateEvalScenarioData(data);
  return data.scenarios.filter(scenario => scenario.evalSets.includes(evalSet));
}

function buildSectionUserPayload(bookName, chapter, section) {
  const targetReferences = section.targetReferences || section.references;
  return {
    task: 'Render reference-only Bible verses for vapourware.ai.',
    book: bookName,
    chapter,
    section: {
      id: section.id,
      startRef: section.startRef,
      endRef: section.endRef,
      label: section.label,
      source: section.source,
    },
    sectionReferences: section.references,
    targetReferences,
    noteKindOptions: NOTE_KIND_VALUES,
    christConnectionOptions: CHRIST_CONNECTION_VALUES,
    constraints: [
      'Return exactly one entry for each target reference in targetReferences.',
      'Use the ref field exactly as provided in targetReferences.',
      'Every returned verse must have a rendering and a note.',
      'Keep notes compact, concrete, and useful. Aim for 12 to 26 words unless a very short list verse needs less.',
      'Do not return entries for other sectionReferences; they are context only.',
    ],
  };
}

function buildSectionRequest({ model, reasoningEffort, bookName, chapter, section }) {
  return {
    model,
    reasoning: { effort: reasoningEffort },
    store: false,
    input: [
      { role: 'system', content: V2_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(buildSectionUserPayload(bookName, chapter, section)) },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'section_rendering',
        strict: true,
        schema: SECTION_RENDER_SCHEMA,
      },
    },
  };
}

function extractResponsesOutputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return null;
}

function validateSectionResult(parsed, section) {
  if (!parsed || !Array.isArray(parsed.verses)) throw new Error('malformed section rendering');
  const targetReferences = section.targetReferences || section.references;
  const wanted = new Set(targetReferences);
  const sectionRefs = new Set(section.references);
  const entriesByRef = new Map();
  const seen = new Set();
  for (const entry of parsed.verses) {
    if (typeof entry.ref !== 'string') throw new Error('unexpected rendered ref');
    parseRef(entry.ref);
    if (!sectionRefs.has(entry.ref)) throw new Error('unexpected rendered ref');
    if (typeof entry.rendering !== 'string' || typeof entry.note !== 'string') throw new Error('malformed verse rendering');
    if (!NOTE_KIND_VALUES.includes(entry.noteKind)) throw new Error('malformed note kind');
    if (!CHRIST_CONNECTION_VALUES.includes(entry.christConnection)) throw new Error('malformed Christ connection');
    if (!wanted.has(entry.ref)) continue;
    if (seen.has(entry.ref)) throw new Error('duplicate rendered ref');
    seen.add(entry.ref);
    entriesByRef.set(entry.ref, entry);
  }
  if (seen.size !== wanted.size) throw new Error('section rendering missing target refs');
  return targetReferences.map(ref => entriesByRef.get(ref));
}

async function renderSectionOnce({ apiUrl, apiKey, model, reasoningEffort, bookName, chapter, section, fetchImpl = fetch }) {
  const r = await fetchImpl(apiUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(SECTION_RENDER_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(buildSectionRequest({ model, reasoningEffort, bookName, chapter, section })),
  });
  if (!r.ok) {
    let message = `section render failed (HTTP ${r.status})`;
    try {
      const errData = await r.json();
      if (errData.error?.message) message = errData.error.message;
    } catch { /* non-JSON error body; keep the status message */ }
    throw new Error(message);
  }
  const data = await r.json();
  const raw = extractResponsesOutputText(data);
  if (typeof raw !== 'string') throw new Error('unexpected Responses API shape');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON from Responses API');
  }
  return validateSectionResult(parsed, section);
}

function renderVersionParts({ model, reasoningEffort }) {
  return [
    RENDER_PIPELINE_V2,
    model,
    reasoningEffort,
    V2_PROMPT_VERSION,
    V2_SYSTEM_PROMPT,
    V2_SCHEMA_VERSION,
    SECTIONS_VERSION,
    SECTIONS_FINGERPRINT,
  ];
}

module.exports = {
  EVAL_SCENARIOS_VERSION,
  RENDER_PIPELINE_V2,
  SECTIONS_FINGERPRINT,
  SECTIONS_VERSION,
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  buildSectionUserPayload,
  evalScenarios,
  evalSections,
  fingerprintSectionMap,
  groupMissingVersesIntoSections,
  parseRef,
  refForEntry,
  renderSectionOnce,
  renderVersionParts,
  sectionRef,
  validateEvalScenarioData,
  validateSectionMap,
  validateSectionResult,
};
