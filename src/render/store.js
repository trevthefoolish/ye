// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Rendered verses: one directory per render version, one JSON file per book.
//
//   {dir}/{renderVersion}/{bookIndex}.json   keys "chapterIndex:verseIndex" (0-based)
//
// The render version hashes everything that shapes the model's output, so a
// change of model, effort, prompt, or schema starts in a fresh, empty
// directory, and changing back finds the previous one untouched. Nothing here
// ever deletes another version's renders.
//
// Reads come from memory after the first touch of a book. Writes update memory
// immediately and persist with tmp+rename, coalesced so a burst of finished
// verses costs at most one in-flight write plus one queued write per book.
//
// Verses still streaming in are provisional: stage() makes them readable at
// once, but they are kept in memory only, are not final (has() is false and
// their chapter is not complete), and are replaced by put() or dropped by
// unstage(). Only put() writes final text, which nothing replaces.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verseCount } = require('../canon');
const { sha256 } = require('../text');

const entryKey = (chapter, verse) => `${chapter - 1}:${verse - 1}`;
const stagedKey = ({ bookIndex, chapter, verse }) => `${bookIndex}:${entryKey(chapter, verse)}`;
const asObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const VERSION_DIR = /^[0-9a-f]{12}$/;

function isEntry(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.rendering === 'string'
    && typeof value.note === 'string'
    && typeof value.v === 'string';
}

// Serializes runs of `task`: schedule() runs it now, or once more after the
// in-flight run, so every caller's promise settles after a run that started
// after its call. idle() settles when nothing is running or queued.
function coalesce(task) {
  let running = null;
  let queued = null;
  const start = () => {
    running = task().finally(() => { running = null; });
    return running;
  };
  return {
    schedule() {
      if (queued) return queued;
      if (!running) return start();
      queued = running.catch(() => {}).then(() => { queued = null; return start(); });
      return queued;
    },
    idle() {
      return (queued || running || Promise.resolve()).catch(() => {});
    },
  };
}

class RenderStore {
  #books = new Map();
  #writers = new Map();
  #completeBodies = new Map();
  #staged = new Map(); // stagedKey -> { rendering, note }

  // dir: the cache root (RENDERS_DIR). This store reads and writes only
  // {dir}/{version}/.
  constructor({ dir, version, log }) {
    this.root = dir;
    this.version = version;
    this.dir = path.join(dir, version);
    this.log = log;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  #file(bookIndex) {
    return path.join(this.dir, `${bookIndex}.json`);
  }

  // Missing files are the normal cold path. Unparseable files are moved aside
  // rather than silently overwritten by the next write. Any other failure
  // (EMFILE, EACCES, ...) throws, so a transient error can never stand in for
  // an empty book and be written back over the real one.
  #read(bookIndex) {
    const file = this.#file(bookIndex);
    try {
      return asObject(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      if (err instanceof SyntaxError) {
        const aside = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, aside); } catch { /* keep going with an empty cache */ }
        this.log.warn('render_cache_corrupt', { book: bookIndex, movedTo: aside, err: err.message });
        return {};
      }
      this.log.error('render_cache_read_failed', { book: bookIndex, err: err.message });
      throw err;
    }
  }

  #book(bookIndex) {
    let data = this.#books.get(bookIndex);
    if (!data) {
      data = this.#read(bookIndex);
      this.#books.set(bookIndex, data);
    }
    return data;
  }

  #current(bookIndex, chapter, verse) {
    const entry = this.#book(bookIndex)[entryKey(chapter, verse)];
    return isEntry(entry) && entry.v === this.version ? entry : null;
  }

  has({ bookIndex, chapter, verse }) {
    return this.#current(bookIndex, chapter, verse) !== null;
  }

  // Current-version verses for a chapter, final or provisional (null where
  // there is neither); `missing` lists the 1-based numbers of verses not final.
  chapter({ bookIndex, chapter }) {
    const count = verseCount(bookIndex, chapter);
    const verses = new Array(count);
    const missing = [];
    for (let verse = 1; verse <= count; verse++) {
      const entry = this.#current(bookIndex, chapter, verse);
      const shown = entry || this.#staged.get(stagedKey({ bookIndex, chapter, verse }));
      verses[verse - 1] = shown ? { rendering: shown.rendering, note: shown.note } : null;
      if (!entry) missing.push(verse);
    }
    return { verses, missing };
  }

  // entries: [{ bookIndex, chapter, verse, rendering, note }], held as
  // provisional text in memory. A verse that is already final is left alone.
  stage(entries) {
    for (const entry of entries) {
      if (!this.has(entry)) this.#staged.set(stagedKey(entry), { rendering: entry.rendering, note: entry.note });
    }
  }

  // Drops the provisional text of these refs, if any.
  unstage(refs) {
    for (const ref of refs) this.#staged.delete(stagedKey(ref));
  }

  // Serialized API body plus ETag for a fully rendered chapter, or null.
  // Memoized until the next write to the same book.
  completeChapter(ref) {
    const key = `${ref.bookIndex}:${ref.chapter}`;
    const memo = this.#completeBodies.get(key);
    if (memo) return memo;
    const { verses, missing } = this.chapter(ref);
    if (missing.length > 0) return null;
    const body = JSON.stringify({ verses, complete: true, missingCount: 0 });
    const result = { body, etag: `"${sha256(body, 16)}"` };
    this.#completeBodies.set(key, result);
    return result;
  }

  // entries: [{ bookIndex, chapter, verse, rendering, note }], as final text
  // that replaces any provisional text for the same verses. Visible to reads
  // immediately; resolves once persisted (never rejects).
  put(entries) {
    const touched = new Set();
    const t = Date.now();
    for (const { bookIndex, chapter, verse, rendering, note } of entries) {
      this.#book(bookIndex)[entryKey(chapter, verse)] = { rendering, note, v: this.version, t };
      this.#staged.delete(stagedKey({ bookIndex, chapter, verse }));
      touched.add(bookIndex);
    }
    for (const bookIndex of touched) {
      for (const key of this.#completeBodies.keys()) {
        if (key.startsWith(`${bookIndex}:`)) this.#completeBodies.delete(key);
      }
    }
    return Promise.all([...touched].map(bookIndex => this.#persist(bookIndex)));
  }

  #persist(bookIndex) {
    let writer = this.#writers.get(bookIndex);
    if (!writer) {
      writer = coalesce(async () => {
        const body = JSON.stringify(this.#books.get(bookIndex), null, 2);
        const file = this.#file(bookIndex);
        const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.writeFile(tmp, body);
        await fs.promises.rename(tmp, file);
      });
      this.#writers.set(bookIndex, writer);
    }
    return writer.schedule().then(() => true, err => {
      this.log.error('cache_write_failed', { book: bookIndex, err: err.message });
      return false;
    });
  }

  // Startup pass, before any reads: removes temp files an interrupted write
  // left in this version's directory, and reports other versions' directories,
  // which are left for an operator to delete.
  prepare() {
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.tmp')) continue;
      try {
        fs.rmSync(path.join(this.dir, name));
      } catch (err) {
        this.log.warn('render_cache_cleanup_failed', { file: path.join(this.dir, name), err: err.message });
      }
    }
    const otherVersions = fs.readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && VERSION_DIR.test(entry.name) && entry.name !== this.version)
      .map(entry => entry.name);
    this.log.info('render_cache_prepared', { dir: this.dir, version: this.version, otherVersions });
    return { otherVersions };
  }

  // Resolves when every write scheduled so far has landed.
  async flush() {
    await Promise.all([...this.#writers.values()].map(writer => writer.idle()));
  }
}

module.exports = { RenderStore };
