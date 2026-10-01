'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const canon = require('../src/canon');

test('the canon has 66 books, 1,189 chapters, and 31,071 verses', () => {
  assert.equal(canon.BOOKS.length, 66);
  assert.equal(canon.CHAPTER_COUNTS.reduce((a, b) => a + b, 0), 1189);
  assert.equal(canon.VERSE_COUNTS.flat().reduce((a, b) => a + b, 0), 31071);
});

test('resolveChapter accepts slugs and names, rejects anything else', () => {
  assert.deepEqual(canon.resolveChapter('song-of-solomon', '2'), { bookIndex: 21, book: 'Song of Solomon', chapter: 2, verseCount: 17 });
  assert.equal(canon.resolveChapter('1 Kings', '3').book, '1 Kings');
  assert.equal(canon.resolveChapter('RUTH', '4').chapter, 4);
  for (const [book, chapter] of [['ruth', '5'], ['ruth', '0'], ['ruth', '1abc'], ['ruth', '-1'], ['nope', '1'], ['', '1']]) {
    assert.equal(canon.resolveChapter(book, chapter), null, `${book} ${chapter}`);
  }
});

test('chapter paths are lowercase slugs', () => {
  assert.equal(canon.chapterPath(21, 1), '/song-of-solomon/1');
  assert.equal(canon.chapterPath(10, 8), '/1-kings/8');
});
