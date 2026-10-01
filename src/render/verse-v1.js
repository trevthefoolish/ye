// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Production pipeline: one Chat Completions call per verse, given only the
// reference ("Ruth 1:1"), returning a rendering and a one-sentence note.

const fs = require('node:fs');
const path = require('node:path');
const { PIPELINE_VERSE } = require('../config');
const { formatRef } = require('../canon');
const { cleanText, sha256 } = require('../text');
const { RenderError, parseStructured, postJson } = require('./xai');

// The prompt text is part of the cache key; the file's trailing newline is not.
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', 'prompts', 'verse-v1.md'), 'utf8').replace(/\n$/, '');

// Cache key for every verse this pipeline renders. Reasoning effort is
// deliberately not part of it (it never was), so existing caches stay valid
// across effort changes. Changing this formula re-renders the whole Bible.
function verseRenderVersion(model) {
  return sha256(model + '\n' + SYSTEM_PROMPT, 12);
}

const SCHEMA = {
  type: 'object',
  properties: {
    rendering: { type: 'string', description: 'A modern English rendering of the verse, translated with care for the original Hebrew/Aramaic/Greek.' },
    note: { type: 'string', description: 'A curious note that MUST be shorter in character count than the rendering. 1-2 sentences max.' },
  },
  required: ['rendering', 'note'],
  additionalProperties: false,
};

function createVersePipeline({ apiUrl, apiKey, model, reasoningEffort, verseTimeoutMs, log, fetchImpl }) {
  async function renderVerse(book, chapter, verse) {
    const ref = formatRef(book, chapter, verse);
    const data = await postJson(apiUrl, {
      model,
      reasoning_effort: reasoningEffort,
      store: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: ref },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'verse_rendering', strict: true, schema: SCHEMA },
      },
    }, { apiKey, timeoutMs: verseTimeoutMs, fetchImpl });

    const parsed = parseStructured(data?.choices?.[0]?.message?.content, 'chat completion');
    if (typeof parsed.rendering !== 'string' || typeof parsed.note !== 'string') {
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
    version: verseRenderVersion(model),
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
