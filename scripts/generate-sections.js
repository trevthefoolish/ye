#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Regenerates data/sections.json (the section-v2 pericope map) from
// OpenBible's crowd-sourced section counts.
//
// For each book, a dynamic program picks the cover that maximizes total
// score: OpenBible sections score votes² × 100,000 + length, so consensus
// dominates, and every verse can also be covered by a small generated
// fallback section (score 1), so coverage is always total.
//
//   node scripts/generate-sections.js [outPath]
//   OPENBIBLE_SECTIONS_URL, OPENBIBLE_MAX_SECTION_VERSES (default 48)

const fs = require('node:fs');
const path = require('node:path');
const { BOOKS, VERSE_COUNTS, getVerseIndex } = require('../src/canon');
const { parsePositiveInt, slugify } = require('../src/text');

const OUT_PATH = process.argv[2] || path.join(__dirname, '..', 'data', 'sections.json');
const OPENBIBLE_URL = process.env.OPENBIBLE_SECTIONS_URL || 'https://a.openbible.info/data/bible-section-counts.txt';
const OPENBIBLE_MAX_VERSES = parsePositiveInt(process.env.OPENBIBLE_MAX_SECTION_VERSES, 48);
const FALLBACK_MAX_VERSES = { Psalms: 24, Proverbs: 8, default: 16 };

const OSIS_BOOKS = [
  'Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1Sam', '2Sam', '1Kgs', '2Kgs', '1Chr', '2Chr',
  'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov', 'Eccl', 'Song', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel',
  'Amos', 'Obad', 'Jonah', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt', 'Mark', 'Luke', 'John',
  'Acts', 'Rom', '1Cor', '2Cor', 'Gal', 'Eph', 'Phil', 'Col', '1Thess', '2Thess', '1Tim', '2Tim', 'Titus', 'Phlm',
  'Heb', 'Jas', '1Pet', '2Pet', '1John', '2John', '3John', 'Jude', 'Rev',
];
const BOOK_BY_OSIS = new Map(OSIS_BOOKS.map((osis, i) => [osis, BOOKS[i]]));

const { refs: REFS, locations: LOCATIONS, ordinals: ORDINALS } = getVerseIndex();

// [start, end) ordinal ranges per book.
const BOOK_BOUNDS = (() => {
  let start = 0;
  return BOOKS.map((book, i) => {
    const end = start + VERSE_COUNTS[i].reduce((a, b) => a + b, 0);
    const bound = { book, start, end };
    start = end;
    return bound;
  });
})();

const fallbackMaxVerses = book => FALLBACK_MAX_VERSES[book] || FALLBACK_MAX_VERSES.default;

function parseOsisRef(osis) {
  const m = /^(.+)\.(\d+)\.(\d+)$/.exec(osis);
  const book = m && BOOK_BY_OSIS.get(m[1]);
  if (!book) return null;
  const ref = `${book} ${Number(m[2])}:${Number(m[3])}`;
  const ord = ORDINALS.get(ref);
  return ord === undefined ? null : { book, ref, ord };
}

// Tab-separated rows: startOsis, endOsis, (unused), votes.
function parseOpenBibleRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [startOsis, endOsis, , votesValue] = line.split('\t');
    const start = parseOsisRef(startOsis);
    const end = parseOsisRef(endOsis);
    if (!start || !end || start.book !== end.book) continue;
    const length = end.ord - start.ord + 1;
    if (length < 1 || length > OPENBIBLE_MAX_VERSES) continue;
    const votes = Number.parseInt(votesValue || '0', 10) || 0;
    rows.push({ source: 'openbible-consensus', from: start.ord, to: end.ord + 1, startOsis, endOsis, votes, score: votes * votes * 100_000 + length });
  }
  return rows;
}

function chooseBookSections(bound, rows) {
  const candidates = new Map();
  for (let ord = bound.start; ord < bound.end; ord++) candidates.set(ord, []);
  for (const row of rows) {
    if (row.from >= bound.start && row.to <= bound.end) candidates.get(row.from).push(row);
  }
  for (let ord = bound.start; ord < bound.end; ord++) {
    for (let length = 1; length <= fallbackMaxVerses(bound.book) && ord + length <= bound.end; length++) {
      candidates.get(ord).push({ source: 'generated-fallback', from: ord, to: ord + length, votes: 0, score: 1 });
    }
  }

  // best[ord]: the highest-scoring cover of [ord, end). Ties prefer fewer
  // sections, then a longer first section.
  const best = new Map([[bound.end, { score: 0, count: 0, path: [] }]]);
  for (let ord = bound.end - 1; ord >= bound.start; ord--) {
    let pick = null;
    for (const candidate of candidates.get(ord)) {
      const tail = best.get(candidate.to);
      if (!tail) continue;
      const next = { score: candidate.score + tail.score, count: tail.count + 1, path: [candidate, ...tail.path] };
      if (!pick
        || next.score > pick.score
        || (next.score === pick.score && next.count < pick.count)
        || (next.score === pick.score && next.count === pick.count && candidate.to > pick.path[0].to)) {
        pick = next;
      }
    }
    if (pick) best.set(ord, pick);
  }
  const solution = best.get(bound.start);
  if (!solution) throw new Error(`could not generate section coverage for ${bound.book}`);
  return solution.path;
}

function toSection(candidate) {
  const start = LOCATIONS.get(REFS[candidate.from]);
  const end = LOCATIONS.get(REFS[candidate.to - 1]);
  const openBible = candidate.source === 'openbible-consensus';
  return {
    id: openBible
      ? `ob-${slugify(candidate.startOsis)}-${slugify(candidate.endOsis)}`
      : `fallback-${slugify(start.book)}-${start.chapter}-${start.verse}-${end.chapter}-${end.verse}`,
    source: candidate.source,
    book: start.book,
    startRef: start.ref,
    endRef: end.ref,
    label: `${start.ref}-${end.ref}`,
    votes: candidate.votes,
    references: REFS.slice(candidate.from, candidate.to),
  };
}

function validate(sections) {
  const ids = new Set();
  const covered = new Array(REFS.length).fill(false);
  for (const section of sections) {
    if (ids.has(section.id)) throw new Error(`duplicate section id: ${section.id}`);
    ids.add(section.id);
    for (const ref of section.references) {
      const ord = ORDINALS.get(ref);
      if (ord === undefined) throw new Error(`unknown section ref: ${ref}`);
      if (covered[ord]) throw new Error(`overlapping section ref: ${ref}`);
      covered[ord] = true;
    }
    if (section.source === 'generated-fallback' && section.references.length > fallbackMaxVerses(section.book)) {
      throw new Error(`oversized fallback section: ${section.id}`);
    }
  }
  const missing = REFS.filter((_, ord) => !covered[ord]);
  if (missing.length) throw new Error(`missing section coverage: ${missing.slice(0, 10).join(', ')}`);
}

function buildSectionMap(text, generatedAt = new Date()) {
  const rows = parseOpenBibleRows(text);
  const sections = BOOK_BOUNDS.flatMap(bound => chooseBookSections(bound, rows).map(toSection));
  validate(sections);
  const sourceCounts = {};
  for (const section of sections) sourceCounts[section.source] = (sourceCounts[section.source] || 0) + 1;
  return {
    version: 'sections-openbible-v1',
    generatedAt: generatedAt.toISOString(),
    source: {
      name: 'OpenBible Bible section counts',
      url: OPENBIBLE_URL,
      maxOpenBibleSectionVerses: OPENBIBLE_MAX_VERSES,
      fallbackMaxVerses: FALLBACK_MAX_VERSES,
    },
    stats: {
      books: BOOKS.length,
      chapters: VERSE_COUNTS.reduce((total, chapters) => total + chapters.length, 0),
      verses: REFS.length,
      sections: sections.length,
      sourceCounts,
      maxSectionVerses: Math.max(...sections.map(section => section.references.length)),
    },
    sections,
  };
}

async function main() {
  const response = await fetch(OPENBIBLE_URL);
  if (!response.ok) throw new Error(`failed to fetch OpenBible sections: ${response.status}`);
  const output = buildSectionMap(await response.text());
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.stats, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { buildSectionMap, parseOpenBibleRows };
