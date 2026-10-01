// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Experimental pipeline (RENDER_PIPELINE=section-v2): renders whole pericope
// sections through the xAI Responses API so notes can see their context.
// Sections come from data/sections.json (OpenBible consensus plus
// deterministic generated fallbacks), which covers every verse exactly once.
// A section may cross chapters, so one call can fill several chapters.

const fs = require('node:fs');
const path = require('node:path');
const { PIPELINE_SECTION } = require('../config');
const { BOOKS, compareRefs, formatRef, getVerseIndex, parseRef, refsBetween, verseCount } = require('../canon');
const { cleanText, renderVersion, sha256, stableStringify } = require('../text');
const { RenderError, requestStructured } = require('./xai');

const PROMPT_VERSION = 'margin-note-v3';
const SCHEMA_VERSION = 'section-render-v1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', `${PROMPT_VERSION}.md`), 'utf8').trim();
const SECTIONS_PATH = path.join(__dirname, '..', '..', 'data', 'sections.json');
const SECTION_SOURCES = new Set(['openbible-consensus', 'generated-fallback', 'manual', 'explicit']);

const NOTE_KINDS = ['lexical', 'literary', 'ancient_context', 'narrative', 'canonical', 'christ_pattern', 'wisdom', 'list_identity', 'other'];
const CHRIST_CONNECTIONS = ['none', 'subtle', 'typological', 'direct', 'fulfilled'];

const SCHEMA = {
  type: 'object',
  properties: {
    verses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The canonical verse reference rendered in this entry, for example "Genesis 1:1".' },
          rendering: { type: 'string', description: 'A faithful, plain, literary modern English rendering of the verse.' },
          note: { type: 'string', description: 'One compact margin-note observation for this verse, usually 12 to 26 words in one or two short sentences.' },
          noteKind: { type: 'string', enum: NOTE_KINDS, description: 'The primary kind of observation used in the note.' },
          christConnection: { type: 'string', enum: CHRIST_CONNECTIONS, description: 'How explicit the Christ-centered canonical connection is.' },
        },
        required: ['ref', 'rendering', 'note', 'noteKind', 'christConnection'],
        additionalProperties: false,
      },
    },
  },
  required: ['verses'],
  additionalProperties: false,
};

// The fixed parts of every request's user message.
const TASK = 'Render reference-only Bible verses for vapourware.ai.';
const CONSTRAINTS = [
  'Return exactly one entry for each target reference in targetReferences.',
  'Use the ref field exactly as provided in targetReferences.',
  'Every returned verse must have a rendering and a note.',
  'Keep notes compact, concrete, and useful. Aim for 12 to 26 words unless a very short list verse needs less.',
  'Do not return entries for other sectionReferences; they are context only.',
];

// --- Section map ---

// Content fingerprint of a section map, ignoring when it was generated.
function fingerprintSectionMap(data) {
  const { generatedAt, ...stable } = data && typeof data === 'object' ? data : {};
  return sha256(stableStringify(stable), 12);
}

function sectionRef(section) {
  return `${section.startRef}-${section.endRef}`;
}

// Fills in derived fields for a section record. Records may list their
// references or give a range (startRef/endRef, or book/chapter/start/end).
function hydrateSection(raw, defaultSource = 'manual') {
  const references = Array.isArray(raw.references) && raw.references.length
    ? raw.references
    : refsBetween(raw.startRef || formatRef(raw.book, raw.chapter, raw.start), raw.endRef || formatRef(raw.book, raw.chapter, raw.end));
  const first = parseRef(references[0]);
  const last = parseRef(references[references.length - 1]);
  const startRef = raw.startRef || first.ref;
  const endRef = raw.endRef || last.ref;
  return {
    ...raw,
    id: raw.id || `${first.book}:${first.chapter}:${first.verse}:${last.verse}`,
    source: raw.source || defaultSource,
    book: raw.book || first.book,
    chapter: first.chapter,
    start: first.verse,
    end: last.verse,
    startRef,
    endRef,
    label: raw.label || `${startRef}-${endRef}`,
    references,
    targetReferences: Array.isArray(raw.targetReferences) && raw.targetReferences.length ? raw.targetReferences : references,
  };
}

// Throws unless the map covers every canonical verse exactly once.
function validateSectionMap(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sections)) {
    throw new Error('sections data must contain a sections array');
  }
  const ids = new Set();
  const covered = new Set();
  const sourceCounts = {};
  const sections = data.sections.map(raw => {
    const section = hydrateSection(raw);
    if (ids.has(section.id)) throw new Error(`duplicate section id: ${section.id}`);
    if (!SECTION_SOURCES.has(section.source)) throw new Error(`unknown section source: ${section.source}`);
    ids.add(section.id);
    sourceCounts[section.source] = (sourceCounts[section.source] || 0) + 1;
    const own = new Set(section.references);
    for (const ref of section.references) {
      parseRef(ref);
      if (covered.has(ref)) throw new Error(`overlapping section ref: ${ref}`);
      covered.add(ref);
    }
    for (const ref of section.targetReferences) {
      if (!own.has(ref)) throw new Error(`target ref outside section ${section.id}: ${ref}`);
    }
    return section;
  });
  const { refs } = getVerseIndex();
  const uncovered = refs.filter(ref => !covered.has(ref));
  if (uncovered.length > 0) {
    throw new Error(`section map has ${uncovered.length} uncovered refs, first missing: ${uncovered[0]}`);
  }
  return { sections, verses: covered.size, expectedVerses: refs.length, sourceCounts };
}

// The committed map, validated and indexed on first use (1.6 MB, so the
// default pipeline never pays for it).
let committedMap = null;

function sectionMap() {
  if (committedMap) return committedMap;
  const data = JSON.parse(fs.readFileSync(SECTIONS_PATH, 'utf8'));
  const { sections } = validateSectionMap(data);
  const byRef = new Map();
  for (const section of sections) {
    for (const ref of section.references) byRef.set(ref, section);
  }
  committedMap = {
    data,
    version: data.version || 'sections-v1',
    fingerprint: fingerprintSectionMap(data),
    sections,
    byRef,
  };
  return committedMap;
}

// The sections covering the given 1-based verses of one chapter, in canonical order.
function sectionsForVerses(book, chapter, verses) {
  const bookIndex = BOOKS.indexOf(book);
  if (bookIndex === -1) throw new Error(`unknown book: ${book}`);
  if (!verseCount(bookIndex, chapter)) throw new Error(`unknown chapter: ${book} ${chapter}`);
  const { byRef } = sectionMap();
  const found = new Map();
  for (const verse of verses) {
    const section = byRef.get(formatRef(book, chapter, verse));
    if (section) found.set(section.id, section);
  }
  return [...found.values()].sort((a, b) => compareRefs(a.startRef, b.startRef) || compareRefs(a.endRef, b.endRef));
}

// --- Rendering ---

// Only reference data reaches the model; eval metadata (genre, risk flags,
// scenario ids) stays out of the payload on purpose.
function buildUserPayload(section) {
  return {
    task: TASK,
    book: section.book,
    chapter: section.chapter,
    section: {
      id: section.id,
      startRef: section.startRef,
      endRef: section.endRef,
      label: section.label,
      source: section.source,
    },
    sectionReferences: section.references,
    targetReferences: section.targetReferences,
    noteKindOptions: NOTE_KINDS,
    christConnectionOptions: CHRIST_CONNECTIONS,
    constraints: CONSTRAINTS,
  };
}

// Returns one entry per target reference, in target order. Extra entries for
// in-section context refs are dropped; anything else is an error.
function validateSectionResult(parsed, section) {
  if (!parsed || !Array.isArray(parsed.verses)) throw new RenderError('malformed section rendering');
  const wanted = new Set(section.targetReferences);
  const inSection = new Set(section.references);
  const byRef = new Map();
  for (const entry of parsed.verses) {
    if (typeof entry.ref !== 'string' || !inSection.has(entry.ref)) throw new RenderError('unexpected rendered ref');
    if (typeof entry.rendering !== 'string' || typeof entry.note !== 'string') throw new RenderError('malformed verse rendering');
    if (!NOTE_KINDS.includes(entry.noteKind)) throw new RenderError('malformed note kind');
    if (!CHRIST_CONNECTIONS.includes(entry.christConnection)) throw new RenderError('malformed Christ connection');
    if (!wanted.has(entry.ref)) continue;
    if (byRef.has(entry.ref)) throw new RenderError('duplicate rendered ref');
    byRef.set(entry.ref, entry);
  }
  if (byRef.size !== wanted.size) throw new RenderError('section rendering missing target refs');
  return section.targetReferences.map(ref => byRef.get(ref));
}

// One Responses API call for a hydrated section. Returns validated entries
// with the model's raw text (callers apply cleanText).
async function renderSection({ apiUrl, apiKey, model, reasoningEffort, timeoutMs, section, fetchImpl }) {
  const parsed = await requestStructured({
    apiUrl, apiKey, model, reasoningEffort, timeoutMs, fetchImpl,
    systemPrompt: SYSTEM_PROMPT,
    user: JSON.stringify(buildUserPayload(section)),
    schemaName: 'section_rendering',
    schema: SCHEMA,
  });
  return validateSectionResult(parsed, section);
}

// Cache key for every verse this pipeline renders: everything that shapes the
// output, including the section map's content.
function sectionRenderVersion({ model, reasoningEffort, map = sectionMap() }) {
  return renderVersion({
    pipeline: PIPELINE_SECTION,
    model,
    reasoningEffort,
    systemPrompt: SYSTEM_PROMPT,
    schema: SCHEMA,
    task: TASK,
    constraints: CONSTRAINTS,
    sections: { version: map.version, fingerprint: map.fingerprint },
  });
}

function createSectionPipeline({ apiUrl, apiKey, model, reasoningEffort, sectionTimeoutMs, fetchImpl }) {
  const map = sectionMap();
  return {
    name: PIPELINE_SECTION,
    version: sectionRenderVersion({ model, reasoningEffort, map }),
    info: { promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, sectionVersion: map.version },
    unit: 'section',

    // One unit per section touching a missing verse, shared across chapters.
    plan({ book, chapter }, missing) {
      return sectionsForVerses(book, chapter, missing).map(section => ({
        key: `section:${section.id}`,
        refs: section.targetReferences.map(parseRef),
        logFields: { book, ch: chapter, sectionId: section.id, sectionRef: sectionRef(section), targetRefs: section.targetReferences.length },
        async render() {
          const entries = await renderSection({ apiUrl, apiKey, model, reasoningEffort, timeoutMs: sectionTimeoutMs, section, fetchImpl });
          return entries.map(entry => {
            const { bookIndex, chapter: c, verse } = parseRef(entry.ref);
            return {
              bookIndex,
              chapter: c,
              verse,
              rendering: cleanText(entry.rendering),
              note: cleanText(entry.note),
              noteKind: entry.noteKind,
              christConnection: entry.christConnection,
            };
          });
        },
      }));
    },
  };
}

module.exports = {
  PROMPT_VERSION,
  SCHEMA_VERSION,
  buildUserPayload,
  createSectionPipeline,
  fingerprintSectionMap,
  hydrateSection,
  renderSection,
  sectionMap,
  sectionRef,
  sectionRenderVersion,
  sectionsForVerses,
  validateSectionMap,
  validateSectionResult,
};
