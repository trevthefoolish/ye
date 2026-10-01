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

module.exports = { BOOKS, CHAPTER_COUNTS, VERSE_COUNTS, chapterPath, formatRef, resolveChapter, toSlug, verseCount };
