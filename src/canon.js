// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// The Protestant canon: 66 books, 1,189 chapters, 31,071 verses. Chapters and
// verses are 1-based everywhere outside the render store's file keys.

const { books: BOOKS, verses: VERSE_COUNTS } = require('../data/bible.json');

const CHAPTER_COUNTS = VERSE_COUNTS.map(chapters => chapters.length);
const BOOK_BY_NAME = new Map(BOOKS.map((name, index) => [name.toLowerCase(), index]));

function toSlug(name) {
  return name.toLowerCase().replace(/ /g, '-');
}

function chapterPath(bookIndex, chapter) {
  return `/${toSlug(BOOKS[bookIndex])}/${chapter}`;
}

function formatRef(book, chapter, verse) {
  return `${book} ${chapter}:${verse}`;
}

function verseCount(bookIndex, chapter) {
  return VERSE_COUNTS[bookIndex]?.[chapter - 1] || 0;
}

// Accepts URL slugs ("song-of-solomon") as well as plain names ("1 Kings"),
// case-insensitively. Returns null for anything that is not a real chapter.
function resolveChapter(bookParam, chapterParam) {
  const bookIndex = BOOK_BY_NAME.get(String(bookParam).replace(/-/g, ' ').toLowerCase());
  if (bookIndex === undefined || !/^\d+$/.test(String(chapterParam))) return null;
  const chapter = Number(chapterParam);
  const verses = verseCount(bookIndex, chapter);
  if (!verses) return null;
  return { bookIndex, book: BOOKS[bookIndex], chapter, verseCount: verses };
}

// Every verse in canonical order, built on first use (only the section
// pipeline and scripts need it).
let verseIndex = null;

function getVerseIndex() {
  if (verseIndex) return verseIndex;
  const refs = [];
  const locations = new Map();
  const ordinals = new Map();
  BOOKS.forEach((book, bookIndex) => {
    VERSE_COUNTS[bookIndex].forEach((count, c) => {
      for (let verse = 1; verse <= count; verse++) {
        const ref = formatRef(book, c + 1, verse);
        ordinals.set(ref, refs.length);
        locations.set(ref, Object.freeze({ ref, book, bookIndex, chapter: c + 1, verse }));
        refs.push(ref);
      }
    });
  });
  verseIndex = { refs, locations, ordinals };
  return verseIndex;
}

function parseRef(ref) {
  const location = getVerseIndex().locations.get(ref);
  if (location) return location;
  throw new Error(/^.+ \d+:\d+$/.test(ref) ? `unknown reference: ${ref}` : `malformed reference: ${ref}`);
}

function compareRefs(a, b) {
  const { ordinals } = getVerseIndex();
  return ordinals.get(a) - ordinals.get(b);
}

// Inclusive range of canonical refs; ranges may cross chapters.
function refsBetween(startRef, endRef) {
  const { refs, ordinals } = getVerseIndex();
  const start = ordinals.get(startRef);
  const end = ordinals.get(endRef);
  if (start === undefined || end === undefined || end < start) {
    throw new Error(`invalid range: ${startRef}-${endRef}`);
  }
  return refs.slice(start, end + 1);
}

module.exports = {
  BOOKS,
  CHAPTER_COUNTS,
  VERSE_COUNTS,
  chapterPath,
  compareRefs,
  formatRef,
  getVerseIndex,
  parseRef,
  refsBetween,
  resolveChapter,
  toSlug,
  verseCount,
};
