#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
const {
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  SECTIONS_VERSION,
  renderSectionOnce,
  smokeEvalSections,
} = require('../rendererV2');

const API_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/responses';
const API_KEY = process.env.XAI_API_KEY;
const MODEL = process.env.RENDER_MODEL || 'grok-4.3';
const REASONING_EFFORT = process.env.RENDER_REASONING_EFFORT || 'none';

if (!API_KEY) {
  console.error('XAI_API_KEY is required for renderer v2 smoke eval.');
  process.exit(1);
}

function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/g, 'vapour');
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function opening(note) {
  return note.replace(/["'()]/g, '').split(/\s+/).slice(0, 4).join(' ').replace(/[,:;.]+$/, '');
}

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function main() {
  const sections = smokeEvalSections();
  const rendered = [];

  for (const section of sections) {
    const entries = await renderSectionOnce({
      apiUrl: API_URL,
      apiKey: API_KEY,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      bookName: section.book,
      chapter: section.chapter,
      section,
    });
    for (const entry of entries) {
      rendered.push({
        ref: `${section.book} ${section.chapter}:${entry.verse}`,
        rendering: cleanText(entry.rendering),
        note: cleanText(entry.note),
        noteKind: entry.noteKind,
        christConnection: entry.christConnection,
      });
    }
  }

  console.log('Renderer v2 smoke eval');
  console.log(`model=${MODEL} reasoning=${REASONING_EFFORT} prompt=${V2_PROMPT_VERSION} schema=${V2_SCHEMA_VERSION} sections=${SECTIONS_VERSION}`);
  console.log('');

  for (const entry of rendered) {
    console.log(`${entry.ref}`);
    console.log(`  rendering: ${entry.rendering}`);
    console.log(`  note: ${entry.note}`);
    console.log(`  meta: noteKind=${entry.noteKind} christConnection=${entry.christConnection} noteWords=${wordCount(entry.note)} noteChars=${entry.note.length}`);
    console.log('');
  }

  const repeatedOpenings = countBy(rendered, e => opening(e.note)).filter(([, count]) => count > 1);
  const noteKinds = countBy(rendered, e => e.noteKind);
  const christConnections = countBy(rendered, e => e.christConnection);
  const echoCount = rendered.filter(e => /\becho(?:es|ing|ed)?\b/i.test(e.note)).length;
  const completeCount = rendered.filter(e => e.rendering && e.note && e.noteKind && e.christConnection).length;
  const noteWords = rendered.map(e => wordCount(e.note));
  const noteChars = rendered.map(e => e.note.length);

  console.log('Metrics');
  console.log(`  verses: ${rendered.length}`);
  console.log(`  schemaComplete: ${completeCount}/${rendered.length}`);
  console.log(`  echoNotes: ${echoCount}`);
  console.log(`  avgNoteWords: ${Math.round(noteWords.reduce((a, b) => a + b, 0) / noteWords.length)}`);
  console.log(`  avgNoteChars: ${Math.round(noteChars.reduce((a, b) => a + b, 0) / noteChars.length)}`);
  console.log(`  repeatedOpenings: ${repeatedOpenings.length ? JSON.stringify(Object.fromEntries(repeatedOpenings)) : 'none'}`);
  console.log(`  noteKinds: ${JSON.stringify(Object.fromEntries(noteKinds))}`);
  console.log(`  christConnections: ${JSON.stringify(Object.fromEntries(christConnections))}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
