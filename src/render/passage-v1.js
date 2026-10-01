// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// The render pipeline: one Responses API call per passage of a chapter (at
// most PASSAGE_MAX_VERSES verses), so the model sees each verse in context and
// writes a passage's notes together. The prompt describes the reader and the
// job and leaves the rest to the model; house style the app needs regardless
// (no em dashes, "vapour") is applied in code by cleanText.

const fs = require('node:fs');
const path = require('node:path');
const { verseCount } = require('../canon');
const { cleanText, renderVersion } = require('../text');
const { RenderError, requestStructured } = require('./xai');

// Part of the render version: renaming it moves the cache.
const NAME = 'passage-v1';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'passage-v1.md'), 'utf8').trim();

const PASSAGE_MAX_VERSES = 10;

const SCHEMA = {
  type: 'object',
  properties: {
    verses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          verse: { type: 'integer' },
          rendering: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['verse', 'rendering', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['verses'],
  additionalProperties: false,
};

// Splits a chapter of `count` verses into contiguous passages of at most `max`
// verses, as even as possible: 22 -> 1-8, 9-15, 16-22. Returns [start, end] pairs.
function passages(count, max = PASSAGE_MAX_VERSES) {
  const parts = Math.ceil(count / max);
  const base = Math.floor(count / parts);
  const extra = count % parts;
  const result = [];
  let start = 1;
  for (let i = 0; i < parts; i++) {
    const end = start + base + (i < extra ? 1 : 0) - 1;
    result.push([start, end]);
    start = end + 1;
  }
  return result;
}

const passageRef = (book, chapter, start, end) => `${book} ${chapter}:${start}-${end}`;

// One entry per verse from start to end, in order. Verses outside the passage
// are ignored; a missing, repeated, or empty verse fails the whole passage.
function validatePassage(parsed, start, end) {
  if (!parsed || !Array.isArray(parsed.verses)) throw new RenderError('malformed passage rendering');
  const byVerse = new Map();
  for (const entry of parsed.verses) {
    if (!Number.isInteger(entry?.verse) || entry.verse < start || entry.verse > end) continue;
    if (byVerse.has(entry.verse)) throw new RenderError(`verse ${entry.verse} rendered twice`);
    if (typeof entry.rendering !== 'string' || !entry.rendering.trim() || typeof entry.note !== 'string' || !entry.note.trim()) {
      throw new RenderError(`malformed verse ${entry.verse}`);
    }
    byVerse.set(entry.verse, entry);
  }
  const result = [];
  for (let verse = start; verse <= end; verse++) {
    if (!byVerse.has(verse)) throw new RenderError(`passage rendering missing verse ${verse}`);
    result.push(byVerse.get(verse));
  }
  return result;
}

// Cache key for every verse this pipeline renders.
function passageRenderVersion({ model, reasoningEffort }) {
  return renderVersion({
    pipeline: NAME,
    model,
    reasoningEffort,
    systemPrompt: SYSTEM_PROMPT,
    schema: SCHEMA,
    passageMaxVerses: PASSAGE_MAX_VERSES,
  });
}

function createPassagePipeline({ apiUrl, apiKey, model, reasoningEffort, passageTimeoutMs, fetchImpl }) {
  async function renderPassage(book, chapter, start, end, usage) {
    const parsed = await requestStructured({
      apiUrl, apiKey, model, reasoningEffort, fetchImpl, usage,
      systemPrompt: SYSTEM_PROMPT,
      user: passageRef(book, chapter, start, end),
      schemaName: 'passage_rendering',
      schema: SCHEMA,
      timeoutMs: passageTimeoutMs,
    });
    return validatePassage(parsed, start, end);
  }

  return {
    name: NAME,
    version: passageRenderVersion({ model, reasoningEffort }),
    unit: 'passage',

    // One unit per passage with a missing verse. The whole passage is
    // rendered for context, but only its missing verses are stored, so text a
    // reader already has never changes under them.
    plan({ bookIndex, book, chapter }, missing) {
      const wanted = new Set(missing);
      return passages(verseCount(bookIndex, chapter)).flatMap(([start, end]) => {
        const verses = missing.filter(verse => verse >= start && verse <= end);
        if (verses.length === 0) return [];
        return [{
          key: `passage:${bookIndex}:${chapter}:${start}-${end}`,
          refs: verses.map(verse => ({ bookIndex, chapter, verse })),
          logFields: { book, ch: chapter, verses: `${start}-${end}` },
          async render(usage) {
            const entries = await renderPassage(book, chapter, start, end, usage);
            return entries
              .filter(entry => wanted.has(entry.verse))
              .map(entry => ({
                bookIndex,
                chapter,
                verse: entry.verse,
                rendering: cleanText(entry.rendering),
                note: cleanText(entry.note),
              }));
          },
        }];
      });
    },
  };
}

module.exports = { PASSAGE_MAX_VERSES, createPassagePipeline, passageRenderVersion, passages, validatePassage };
