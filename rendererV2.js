// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');

const { books: BOOKS, verses: VERSES } = require('./data/bible.json');
const SECTIONS_DATA = require('./data/sections.json');

const RENDER_PIPELINE_V2 = 'section-v2';
const V2_PROMPT_VERSION = 'margin-note-v2';
const V2_SCHEMA_VERSION = 'section-render-v1';
const V2_SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts', 'margin-note-v2.md'), 'utf8').trim();
const SECTIONS_VERSION = SECTIONS_DATA.version || 'sections-v1';

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
          verse: {
            type: 'integer',
            description: 'The 1-based verse number rendered in this entry.',
          },
          rendering: {
            type: 'string',
            description: 'A faithful, plain, literary modern English rendering of the verse.',
          },
          note: {
            type: 'string',
            description: 'One brief margin-note observation for this verse.',
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
        required: ['verse', 'rendering', 'note', 'noteKind', 'christConnection'],
        additionalProperties: false,
      },
    },
  },
  required: ['verses'],
  additionalProperties: false,
};

function sectionRefs(bookName, chapter, startVerse, endVerse) {
  const refs = [];
  for (let verse = startVerse; verse <= endVerse; verse++) {
    refs.push(`${bookName} ${chapter}:${verse}`);
  }
  return refs;
}

function explicitSectionsFor(bookName, chapter) {
  return SECTIONS_DATA.sections
    .filter(s => s.book === bookName && s.chapter === chapter)
    .map(s => ({ ...s, source: 'explicit' }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function fallbackWindowSize(bookName) {
  if (bookName === 'Psalms') return 24;
  if (bookName === 'Proverbs') return 8;
  return 16;
}

function fallbackSectionFor(bookName, chapter, verse, verseCount) {
  if (bookName === 'Psalms' && verseCount <= 24) {
    return { book: bookName, chapter, start: 1, end: verseCount, label: 'Whole psalm', source: 'fallback' };
  }
  const size = fallbackWindowSize(bookName);
  const start = Math.floor((verse - 1) / size) * size + 1;
  const end = Math.min(verseCount, start + size - 1);
  return { book: bookName, chapter, start, end, label: `${bookName} ${chapter}:${start}-${end}`, source: 'fallback' };
}

function fallbackSectionOutsideExplicit(bookName, chapter, verse, verseCount, explicit) {
  const section = fallbackSectionFor(bookName, chapter, verse, verseCount);
  for (const s of explicit) {
    if (s.end < verse && s.end >= section.start) section.start = s.end + 1;
    if (s.start > verse && s.start <= section.end) section.end = s.start - 1;
  }
  section.label = `${bookName} ${chapter}:${section.start}-${section.end}`;
  return section;
}

function sectionKey(section) {
  return `${section.book}:${section.chapter}:${section.start}:${section.end}`;
}

function groupMissingVersesIntoSections(bookName, chapter, missingZeroBased) {
  const bookIndex = BOOKS.indexOf(bookName);
  if (bookIndex === -1) throw new Error(`unknown book: ${bookName}`);
  const verseCount = VERSES[bookIndex]?.[chapter - 1];
  if (!verseCount) throw new Error(`unknown chapter: ${bookName} ${chapter}`);

  const explicit = explicitSectionsFor(bookName, chapter);
  const groups = new Map();
  for (const v of missingZeroBased) {
    const verse = v + 1;
    const section = explicit.find(s => verse >= s.start && verse <= s.end)
      || fallbackSectionOutsideExplicit(bookName, chapter, verse, verseCount, explicit);
    const key = sectionKey(section);
    if (!groups.has(key)) {
      groups.set(key, {
        ...section,
        targetVerses: [],
        references: sectionRefs(bookName, chapter, section.start, section.end),
      });
    }
    groups.get(key).targetVerses.push(verse);
  }
  return [...groups.values()].sort((a, b) => a.start - b.start || a.end - b.end);
}

function buildSectionUserPayload(bookName, chapter, section) {
  return {
    task: 'Render reference-only Bible verses for vapourware.ai.',
    book: bookName,
    chapter,
    section: {
      startVerse: section.start,
      endVerse: section.end,
      label: section.label,
      source: section.source,
    },
    sectionReferences: section.references,
    targetVerses: section.targetVerses,
    noteKindOptions: NOTE_KIND_VALUES,
    christConnectionOptions: CHRIST_CONNECTION_VALUES,
    constraints: [
      'Return exactly one entry for each target verse.',
      'Every returned verse must have a rendering and a note.',
      'Keep notes brief and concrete.',
      'Do not return entries for non-target verses.',
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
  const wanted = new Set(section.targetVerses);
  const seen = new Set();
  for (const entry of parsed.verses) {
    if (!Number.isInteger(entry.verse) || !wanted.has(entry.verse)) throw new Error('unexpected rendered verse');
    if (seen.has(entry.verse)) throw new Error('duplicate rendered verse');
    if (typeof entry.rendering !== 'string' || typeof entry.note !== 'string') throw new Error('malformed verse rendering');
    if (!NOTE_KIND_VALUES.includes(entry.noteKind)) throw new Error('malformed note kind');
    if (!CHRIST_CONNECTION_VALUES.includes(entry.christConnection)) throw new Error('malformed Christ connection');
    seen.add(entry.verse);
  }
  if (seen.size !== wanted.size) throw new Error('section rendering missing target verses');
  return parsed.verses;
}

async function renderSectionOnce({ apiUrl, apiKey, model, reasoningEffort, bookName, chapter, section, fetchImpl = fetch }) {
  const r = await fetchImpl(apiUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(buildSectionRequest({ model, reasoningEffort, bookName, chapter, section })),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'section render failed');
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

function smokeEvalSections() {
  return [
    { book: 'Genesis', chapter: 1, start: 1, end: 5 },
    { book: 'Ecclesiastes', chapter: 1, start: 1, end: 3 },
    { book: 'Nehemiah', chapter: 12, start: 1, end: 4 },
    { book: 'Luke', chapter: 24, start: 25, end: 27 },
  ].map(target => {
    const section = explicitSectionsFor(target.book, target.chapter)
      .find(s => s.start === target.start && s.end === target.end)
      || { ...target, label: `${target.book} ${target.chapter}:${target.start}-${target.end}`, source: 'eval' };
    return {
      ...section,
      targetVerses: Array.from({ length: target.end - target.start + 1 }, (_, i) => target.start + i),
      references: sectionRefs(target.book, target.chapter, target.start, target.end),
    };
  });
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
  ];
}

module.exports = {
  CHRIST_CONNECTION_VALUES,
  NOTE_KIND_VALUES,
  RENDER_PIPELINE_V2,
  SECTIONS_VERSION,
  SECTION_RENDER_SCHEMA,
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  V2_SYSTEM_PROMPT,
  buildSectionRequest,
  buildSectionUserPayload,
  extractResponsesOutputText,
  groupMissingVersesIntoSections,
  renderSectionOnce,
  renderVersionParts,
  smokeEvalSections,
  validateSectionResult,
};
