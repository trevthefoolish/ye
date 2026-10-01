// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Production pipeline: one Responses API call per verse, given only the
// reference ("Ruth 1:1"), returning a rendering and a one-sentence note.

const fs = require('node:fs');
const path = require('node:path');
const { PIPELINE_VERSE } = require('../config');
const { formatRef } = require('../canon');
const { cleanText, renderVersion } = require('../text');
const { RenderError, requestStructured } = require('./xai');

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'verse-v1.md'), 'utf8').trim();

const SCHEMA = {
  type: 'object',
  properties: {
    rendering: { type: 'string', description: 'A modern English rendering of the verse, translated with care for the original Hebrew/Aramaic/Greek.' },
    note: { type: 'string', description: 'A curious note that MUST be shorter in character count than the rendering. 1-2 sentences max.' },
  },
  required: ['rendering', 'note'],
  additionalProperties: false,
};

// Cache key for every verse this pipeline renders. Changing any input
// re-renders the Bible from scratch as people read it.
function verseRenderVersion({ model, reasoningEffort }) {
  return renderVersion({ pipeline: PIPELINE_VERSE, model, reasoningEffort, systemPrompt: SYSTEM_PROMPT, schema: SCHEMA });
}

function createVersePipeline({ apiUrl, apiKey, model, reasoningEffort, verseTimeoutMs, log, fetchImpl }) {
  async function renderVerse(book, chapter, verse) {
    const ref = formatRef(book, chapter, verse);
    const parsed = await requestStructured({
      apiUrl, apiKey, model, reasoningEffort, fetchImpl,
      systemPrompt: SYSTEM_PROMPT,
      user: ref,
      schemaName: 'verse_rendering',
      schema: SCHEMA,
      timeoutMs: verseTimeoutMs,
    });
    if (typeof parsed?.rendering !== 'string' || typeof parsed?.note !== 'string') {
      throw new RenderError('malformed verse rendering');
    }
    const rendering = cleanText(parsed.rendering);
    const note = cleanText(parsed.note);
    // The prompt asks for notes shorter than the verse; surface misses.
    if (note.length >= rendering.length) {
      log.warn('note_too_long', { book, ch: chapter, verse, noteLen: note.length, renderLen: rendering.length });
    }
    return { rendering, note };
  }

  return {
    name: PIPELINE_VERSE,
    version: verseRenderVersion({ model, reasoningEffort }),
    info: { promptVersion: 'verse-v1', schemaVersion: 'verse-v1', sectionVersion: null },
    unit: 'verse',

    // One unit per missing verse.
    plan({ bookIndex, book, chapter }, missing) {
      return missing.map(verse => ({
        key: `verse:${bookIndex}:${chapter}:${verse}`,
        refs: [{ bookIndex, chapter, verse }],
        logFields: { book, ch: chapter, verse },
        async render() {
          return [{ bookIndex, chapter, verse, ...await renderVerse(book, chapter, verse) }];
        },
      }));
    },
  };
}

module.exports = { createVersePipeline, verseRenderVersion };
