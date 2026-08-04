#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIBLE = require('../data/bible.json');
const { parsePositiveInt, slugify } = require('../utils');
const OUT_PATH = path.join(ROOT, 'data', 'sections.json');
const OPENBIBLE_URL = process.env.OPENBIBLE_SECTIONS_URL || 'https://a.openbible.info/data/bible-section-counts.txt';
const OPENBIBLE_MAX_VERSES = parsePositiveInt(process.env.OPENBIBLE_MAX_SECTION_VERSES, 48);

const OSIS_TO_BOOK = {
  Gen: 'Genesis',
  Exod: 'Exodus',
  Lev: 'Leviticus',
  Num: 'Numbers',
  Deut: 'Deuteronomy',
  Josh: 'Joshua',
  Judg: 'Judges',
  Ruth: 'Ruth',
  '1Sam': '1 Samuel',
  '2Sam': '2 Samuel',
  '1Kgs': '1 Kings',
  '2Kgs': '2 Kings',
  '1Chr': '1 Chronicles',
  '2Chr': '2 Chronicles',
  Ezra: 'Ezra',
  Neh: 'Nehemiah',
  Esth: 'Esther',
  Job: 'Job',
  Ps: 'Psalms',
  Prov: 'Proverbs',
  Eccl: 'Ecclesiastes',
  Song: 'Song of Solomon',
  Isa: 'Isaiah',
  Jer: 'Jeremiah',
  Lam: 'Lamentations',
  Ezek: 'Ezekiel',
  Dan: 'Daniel',
  Hos: 'Hosea',
  Joel: 'Joel',
  Amos: 'Amos',
  Obad: 'Obadiah',
  Jonah: 'Jonah',
  Mic: 'Micah',
  Nah: 'Nahum',
  Hab: 'Habakkuk',
  Zeph: 'Zephaniah',
  Hag: 'Haggai',
  Zech: 'Zechariah',
  Mal: 'Malachi',
  Matt: 'Matthew',
  Mark: 'Mark',
  Luke: 'Luke',
  John: 'John',
  Acts: 'Acts',
  Rom: 'Romans',
  '1Cor': '1 Corinthians',
  '2Cor': '2 Corinthians',
  Gal: 'Galatians',
  Eph: 'Ephesians',
  Phil: 'Philippians',
  Col: 'Colossians',
  '1Thess': '1 Thessalonians',
  '2Thess': '2 Thessalonians',
  '1Tim': '1 Timothy',
  '2Tim': '2 Timothy',
  Titus: 'Titus',
  Phlm: 'Philemon',
  Heb: 'Hebrews',
  Jas: 'James',
  '1Pet': '1 Peter',
  '2Pet': '2 Peter',
  '1John': '1 John',
  '2John': '2 John',
  '3John': '3 John',
  Jude: 'Jude',
  Rev: 'Revelation',
};

const BOOK_TO_OSIS = Object.fromEntries(Object.entries(OSIS_TO_BOOK).map(([osis, book]) => [book, osis]));
const BOOKS = BIBLE.books;
const VERSES = BIBLE.verses;
const ORD_BY_REF = new Map();
const REF_BY_ORD = [];
const BOOK_BOUNDS = [];

let ordinal = 0;
for (const [bookIndex, book] of BOOKS.entries()) {
  const start = ordinal;
  for (let chapter = 1; chapter <= VERSES[bookIndex].length; chapter++) {
    for (let verse = 1; verse <= VERSES[bookIndex][chapter - 1]; verse++) {
      const ref = refForEntry(book, chapter, verse);
      ORD_BY_REF.set(ref, ordinal);
      REF_BY_ORD[ordinal] = { book, chapter, verse, ref };
      ordinal++;
    }
  }
  BOOK_BOUNDS.push({ book, start, end: ordinal });
}

function fallbackWindowSize(book) {
  if (book === 'Psalms') return 24;
  if (book === 'Proverbs') return 8;
  return 16;
}

function refForEntry(book, chapter, verse) {
  return `${book} ${chapter}:${verse}`;
}

function parseOsisRef(ref) {
  const m = /^(.+)\.(\d+)\.(\d+)$/.exec(ref);
  if (!m) return null;
  const book = OSIS_TO_BOOK[m[1]];
  if (!book) return null;
  const canonical = refForEntry(book, Number(m[2]), Number(m[3]));
  const ord = ORD_BY_REF.get(canonical);
  if (ord === undefined) return null;
  return { book, chapter: Number(m[2]), verse: Number(m[3]), ref: canonical, ord };
}

function refsForOrdRange(from, to) {
  const refs = [];
  for (let ord = from; ord < to; ord++) refs.push(REF_BY_ORD[ord].ref);
  return refs;
}

function fallbackCandidatesFor(book, from, bookEnd) {
  const size = fallbackWindowSize(book);
  const candidates = [];
  for (let len = 1; len <= size && from + len <= bookEnd; len++) {
    candidates.push({
      source: 'generated-fallback',
      from,
      to: from + len,
      votes: 0,
      score: 1,
    });
  }
  return candidates;
}

function parseOpenBibleRows(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [startOsis, endOsis, , countValue] = line.split('\t');
    const start = parseOsisRef(startOsis);
    const end = parseOsisRef(endOsis);
    if (!start || !end || start.book !== end.book) continue;
    const len = end.ord - start.ord + 1;
    if (len < 1 || len > OPENBIBLE_MAX_VERSES) continue;
    const votes = Number.parseInt(countValue || '0', 10) || 0;
    const score = (votes * votes * 100_000) + len;
    rows.push({
      source: 'openbible-consensus',
      from: start.ord,
      to: end.ord + 1,
      startOsis,
      endOsis,
      votes,
      score,
    });
  }
  return rows;
}

function chooseBookSections(bookBound, openBibleRows) {
  const candidatesByStart = new Map();
  for (const row of openBibleRows) {
    if (row.from < bookBound.start || row.to > bookBound.end) continue;
    if (!candidatesByStart.has(row.from)) candidatesByStart.set(row.from, []);
    candidatesByStart.get(row.from).push(row);
  }
  for (let ord = bookBound.start; ord < bookBound.end; ord++) {
    const candidates = candidatesByStart.get(ord) || [];
    candidates.push(...fallbackCandidatesFor(bookBound.book, ord, bookBound.end));
    candidatesByStart.set(ord, candidates);
  }

  const dp = new Map([[bookBound.end, { score: 0, count: 0, path: [] }]]);
  for (let ord = bookBound.end - 1; ord >= bookBound.start; ord--) {
    let best = null;
    for (const candidate of candidatesByStart.get(ord) || []) {
      const tail = dp.get(candidate.to);
      if (!tail) continue;
      const next = {
        score: candidate.score + tail.score,
        count: 1 + tail.count,
        path: [candidate, ...tail.path],
      };
      if (!best
        || next.score > best.score
        || (next.score === best.score && next.count < best.count)
        || (next.score === best.score && next.count === best.count && candidate.to > best.path[0].to)) {
        best = next;
      }
    }
    if (best) dp.set(ord, best);
  }
  const solution = dp.get(bookBound.start);
  if (!solution) throw new Error(`could not generate section coverage for ${bookBound.book}`);
  return solution.path;
}

function sectionFromCandidate(candidate) {
  const start = REF_BY_ORD[candidate.from];
  const end = REF_BY_ORD[candidate.to - 1];
  const references = refsForOrdRange(candidate.from, candidate.to);
  const sectionRef = `${start.ref}-${end.ref}`;
  const idPrefix = candidate.source === 'openbible-consensus' ? 'ob' : 'fallback';
  const id = candidate.source === 'openbible-consensus'
    ? `${idPrefix}-${slugify(candidate.startOsis)}-${slugify(candidate.endOsis)}`
    : `${idPrefix}-${slugify(start.book)}-${start.chapter}-${start.verse}-${end.chapter}-${end.verse}`;
  return {
    id,
    source: candidate.source,
    book: start.book,
    startRef: start.ref,
    endRef: end.ref,
    label: sectionRef,
    votes: candidate.votes,
    references,
  };
}

function validateGeneratedSections(sections) {
  const seen = new Set();
  const covered = new Array(REF_BY_ORD.length).fill(false);
  for (const section of sections) {
    if (seen.has(section.id)) throw new Error(`duplicate section id: ${section.id}`);
    seen.add(section.id);
    for (const ref of section.references) {
      const ord = ORD_BY_REF.get(ref);
      if (ord === undefined) throw new Error(`unknown section ref: ${ref}`);
      if (covered[ord]) throw new Error(`overlapping section ref: ${ref}`);
      covered[ord] = true;
    }
    if (section.source === 'generated-fallback') {
      const first = REF_BY_ORD[ORD_BY_REF.get(section.references[0])];
      if (section.references.length > fallbackWindowSize(first.book)) {
        throw new Error(`oversized fallback section: ${section.id}`);
      }
    }
  }
  const missing = [];
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) missing.push(REF_BY_ORD[i].ref);
  }
  if (missing.length) throw new Error(`missing section coverage: ${missing.slice(0, 10).join(', ')}`);
}

async function main() {
  const response = await fetch(OPENBIBLE_URL);
  if (!response.ok) throw new Error(`failed to fetch OpenBible sections: ${response.status}`);
  const text = await response.text();
  const openBibleRows = parseOpenBibleRows(text);
  const sections = [];
  for (const bookBound of BOOK_BOUNDS) {
    sections.push(...chooseBookSections(bookBound, openBibleRows).map(sectionFromCandidate));
  }
  validateGeneratedSections(sections);

  const sourceCounts = sections.reduce((counts, section) => {
    counts[section.source] = (counts[section.source] || 0) + 1;
    return counts;
  }, {});
  const output = {
    version: 'sections-openbible-v1',
    generatedAt: new Date().toISOString(),
    source: {
      name: 'OpenBible Bible section counts',
      url: OPENBIBLE_URL,
      maxOpenBibleSectionVerses: OPENBIBLE_MAX_VERSES,
      fallbackMaxVerses: {
        Psalms: 24,
        Proverbs: 8,
        default: 16,
      },
    },
    stats: {
      books: BOOKS.length,
      chapters: VERSES.reduce((total, chapters) => total + chapters.length, 0),
      verses: REF_BY_ORD.length,
      sections: sections.length,
      sourceCounts,
      maxSectionVerses: Math.max(...sections.map(section => section.references.length)),
    },
    sections,
  };
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.stats, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
