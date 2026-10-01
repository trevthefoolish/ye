// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Rendered verses, one JSON file per book: `{dir}/{bookIndex}.json`, keyed by
// "chapterIndex:verseIndex" (both 0-based). Each entry is stamped with the
// render version that produced it; entries from any other version are
// invisible, so changing the model or prompt re-renders on demand without
// deleting anything.
//
// Reads come from memory after the first touch of a book. Writes update memory
// immediately and persist with tmp+rename, coalesced so a burst of finished
// verses costs at most one in-flight write plus one queued write per book.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verseCount } = require('../canon');
const { sha256 } = require('../text');

const entryKey = (chapter, verse) => `${chapter - 1}:${verse - 1}`;

function isEntry(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.rendering === 'string'
    && typeof value.note === 'string'
    && typeof value.v === 'string';
}

function sameEntry(a, b) {
  return isEntry(a) && isEntry(b)
    && a.v === b.v
    && a.rendering === b.rendering
    && a.note === b.note
    && a.noteKind === b.noteKind
    && a.christConnection === b.christConnection;
}

// Folds current-version entries from the committed seed into a live cache
// file. Stale or malformed seed entries are skipped; live-only entries are
// kept. Pure, so it can be tested without touching disk.
function mergeSeed(source, dest, version, { destCorrupt = false } = {}) {
  const cache = { ...(dest && typeof dest === 'object' ? dest : {}) };
  const stats = { changed: false, added: 0, replaced: 0, skippedStale: 0, skippedMalformed: 0 };
  for (const [key, value] of Object.entries(source && typeof source === 'object' ? source : {})) {
    if (!isEntry(value)) { stats.skippedMalformed++; continue; }
    if (value.v !== version) { stats.skippedStale++; continue; }
    if (key in cache && sameEntry(cache[key], value)) continue;
    // A corrupt destination counts as replaced: its entries existed before.
    if (key in cache || destCorrupt) stats.replaced++;
    else stats.added++;
    cache[key] = value;
    stats.changed = true;
  }
  return { cache, ...stats };
}

function writeFileAtomic(file, body) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
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

  constructor({ dir, version, log }) {
    this.dir = dir;
    this.version = version;
    this.log = log;
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(bookIndex) {
    return path.join(this.dir, `${bookIndex}.json`);
  }

  // Missing files are the normal cold path. Unparseable files are moved aside
  // rather than silently overwritten by the next write.
  #read(bookIndex) {
    const file = this.#file(bookIndex);
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), corrupt: false };
    } catch (err) {
      if (err.code === 'ENOENT') return { data: {}, corrupt: false };
      if (err instanceof SyntaxError) {
        const aside = `${file}.corrupt-${Date.now()}`;
        try { fs.renameSync(file, aside); } catch { /* keep going with an empty cache */ }
        this.log.warn('render_cache_corrupt', { book: bookIndex, movedTo: aside, err: err.message });
        return { data: {}, corrupt: true };
      }
      this.log.warn('render_cache_read_failed', { book: bookIndex, err: err.message });
      return { data: {}, corrupt: false };
    }
  }

  #book(bookIndex) {
    let data = this.#books.get(bookIndex);
    if (!data) {
      data = this.#read(bookIndex).data;
      this.#books.set(bookIndex, data);
    }
    return data;
  }

  #current(bookIndex, chapter, verse) {
    const entry = this.#book(bookIndex)[entryKey(chapter, verse)];
    return entry && entry.v === this.version ? entry : null;
  }

  has({ bookIndex, chapter, verse }) {
    return this.#current(bookIndex, chapter, verse) !== null;
  }

  // Current-version verses for a chapter; `missing` lists 1-based verse numbers.
  chapter({ bookIndex, chapter }) {
    const count = verseCount(bookIndex, chapter);
    const verses = new Array(count);
    const missing = [];
    for (let verse = 1; verse <= count; verse++) {
      const entry = this.#current(bookIndex, chapter, verse);
      verses[verse - 1] = entry ? { rendering: entry.rendering, note: entry.note } : null;
      if (!entry) missing.push(verse);
    }
    return { verses, missing };
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

  // Any-version rendering of one verse, for meta descriptions on cold pages.
  anyRendering({ bookIndex, chapter, verse }) {
    const entry = this.#book(bookIndex)[entryKey(chapter, verse)];
    return typeof entry?.rendering === 'string' ? entry.rendering : null;
  }

  // entries: [{ bookIndex, chapter, verse, rendering, note, noteKind?, christConnection? }].
  // Visible to reads immediately; resolves once persisted (never rejects).
  put(entries) {
    const touched = new Set();
    const t = Date.now();
    for (const { bookIndex, chapter, verse, rendering, note, noteKind, christConnection } of entries) {
      const entry = { rendering, note };
      if (noteKind !== undefined) entry.noteKind = noteKind;
      if (christConnection !== undefined) entry.christConnection = christConnection;
      this.#book(bookIndex)[entryKey(chapter, verse)] = { ...entry, v: this.version, t };
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

  // Merges the committed seed directory into this store's directory. Runs
  // once at startup, before any reads.
  seedFrom(seedDir) {
    const totals = { files: 0, added: 0, replaced: 0, skippedStale: 0, skippedMalformed: 0 };
    try {
      for (const file of fs.readdirSync(seedDir)) {
        if (!/^\d+\.json$/.test(file)) continue;
        const bookIndex = Number(file.slice(0, -5));
        const source = JSON.parse(fs.readFileSync(path.join(seedDir, file), 'utf8'));
        const dest = this.#read(bookIndex);
        const merged = mergeSeed(source, dest.data, this.version, { destCorrupt: dest.corrupt });
        for (const key of ['added', 'replaced', 'skippedStale', 'skippedMalformed']) totals[key] += merged[key];
        if (merged.changed) {
          writeFileAtomic(this.#file(bookIndex), JSON.stringify(merged.cache, null, 2));
          totals.files++;
        }
      }
      if (Object.values(totals).some(Boolean)) this.log.info('render_cache_seeded', { ...totals, dir: this.dir });
    } catch (err) {
      this.log.error('render_cache_seed_failed', { err: err.message });
    }
    return totals;
  }

  // Resolves when every write scheduled so far has landed.
  async flush() {
    await Promise.all([...this.#writers.values()].map(writer => writer.idle()));
  }
}

module.exports = { RenderStore, mergeSeed };
