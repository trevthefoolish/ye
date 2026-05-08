// Copyright (c) 2026 vapourware.ai All rights reserved.
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const { log, logRouter, analyticsRouter, parseCookie } = require('./logger');
const { mergeSeedRenderCache } = require('./renderCache');
const {
  RENDER_PIPELINE_V2,
  SECTIONS_VERSION,
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  groupMissingVersesIntoSections,
  parseRef,
  renderSectionOnce,
  renderVersionParts,
  sectionRef,
} = require('./rendererV2');

// --- App version ---
const APP_VERSION = require('./package.json').version;

// --- Bible data ---
const { books: BOOKS, verses: VERSES } = require('./data/bible.json');
const CHAPTERS = VERSES.map(v => v.length);
const BOOKS_LOWER = BOOKS.map(b => b.toLowerCase());

// --- Constants ---
const API_TIMEOUT_MS = 30_000;
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_ONE_DAY = 'public, max-age=86400';
const RENDER_CONCURRENCY = parsePositiveInt(process.env.RENDER_CONCURRENCY, 8);
const DEFAULT_PATH = '/ecclesiastes/1';
const PARTIAL_RETRY_MS = 2_000;
const RENDER_PRIORITY_FOREGROUND = 'foreground';
const RENDER_PRIORITY_BACKGROUND = 'background';

// --- Asset fingerprinting ---
const CSS_SRC = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
const JS_RAW = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
let JS_SRC = JS_RAW;
let JS_HASH;

const app = express();
// Fastly (CDN) -> Railway edge -> Node. Trust exactly 2 proxies so req.ip
// resolves to the real client IP for rate limiting and analytics. Trusting
// a specific hop count (vs `true`) prevents XFF spoofing from the internet.
app.set('trust proxy', 2);
const RENDER_PIPELINE = process.env.RENDER_PIPELINE === RENDER_PIPELINE_V2 ? RENDER_PIPELINE_V2 : 'verse-v1';
const RENDER_MODEL = process.env.RENDER_MODEL || 'grok-4.3';
const RENDER_REASONING_EFFORT = process.env.RENDER_REASONING_EFFORT || 'none';
const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) { log.error('missing_api_key'); process.exit(1); }
const XAI_API_URL = process.env.XAI_API_URL
  || (RENDER_PIPELINE === RENDER_PIPELINE_V2
    ? 'https://api.x.ai/v1/responses'
    : 'https://api.x.ai/v1/chat/completions');
process.on('unhandledRejection', reason => log.error('unhandled_rejection', { err: String(reason) }));
const SOURCE_RENDERS_DIR = path.join(__dirname, 'renders');
const RENDERS_DIR = process.env.RENDERS_DIR ? path.resolve(process.env.RENDERS_DIR) : SOURCE_RENDERS_DIR;
fs.mkdirSync(RENDERS_DIR, { recursive: true });

const SYSTEM_PROMPT = `You are a biblical scholar who helps people see how the Bible is a unified story that leads to Jesus. Your voice is warm, curious, and accessible — like a friend who's deeply studied this stuff and can't wait to show you what they found.

<theological-framework>
The Bible is ancient, unified, meditation literature. It was written in another time and culture, has many authors and literary styles, but tells one connected story. It's designed to reveal its meaning over a lifetime of re-reading. Every book, theme, and narrative thread participates in a larger story that comes to fulfillment in Jesus.

Read every passage through these seven lenses:
- Messianic: every narrative thread contributes to the story that finds fulfillment in Jesus' life, death, resurrection, and the gift of the Spirit
- Communal: the Bible addresses communities and peoples, not just isolated individuals
- Human and Divine: Scripture holds together human authorship and divine inspiration
- Ancient: honor the original ancient Near Eastern and Greco-Roman contexts
- Unified: trace intertextual connections across books, authors, and testaments
- Wisdom: the Bible trains readers in wisdom and character transformation, not just information
- Meditation: designed for slow re-reading that reveals layers of meaning over time

Scripture interprets Scripture. Hold tensions without forcing resolution. Jesus fulfills the Hebrew Scriptures; he does not replace them.
</theological-framework>

<core-values>
Wonder over certainty. Humility before the text. Depth without jargon. Accessibility without dumbing down. Faithfulness to the text over novelty.
</core-values>

<rendering-guidelines>
- Produce a standalone modern English rendering of the verse
- Don't paraphrase loosely — translate with care for the original Hebrew/Aramaic/Greek
- Use vivid, concrete language rather than churchy abstractions
- Let the poetry be poetic and the prose be direct
- Honor the ancient literary context — preserve wordplay, imagery, and structural patterns where possible
- When the verse participates in intertextual patterns (repeated words, allusions to earlier passages), let those echoes come through in the English
- Never use em dashes (—). Use commas, periods, colons, semicolons, or separate sentences instead
</rendering-guidelines>

<note-guidelines>
CRITICAL LENGTH RULE: the note MUST be shorter than the verse. One sentence only. Aim for half the verse's length. If the verse is short, the note must be very short.

- Think "margin scribble" not "commentary." One punchy observation
- Vary your angle each time: wordplay in the original language, intertextual echo, ancient cultural context, narrative placement, wisdom for character formation. Pick ONE angle per note
- Only mention Jesus when the verse has a direct, specific connection. Most verses should stand in their own context
- Don't moralize. Just illuminate one surprising thing about this text
</note-guidelines>`;

const RENDER_VERSION = crypto
  .createHash('sha256')
  .update(RENDER_PIPELINE === RENDER_PIPELINE_V2
    ? renderVersionParts({ model: RENDER_MODEL, reasoningEffort: RENDER_REASONING_EFFORT }).join('\n')
    : RENDER_MODEL + '\n' + SYSTEM_PROMPT)
  .digest('hex')
  .slice(0, 12);

function toSlug(name) { return name.toLowerCase().replace(/ /g, '-'); }

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/gi, 'vapour');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

app.disable('x-powered-by');

// --- Security headers ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(compression());
app.use(logRouter, analyticsRouter);

// --- Health check (before static, no compression overhead) ---
app.get('/health', (req, res) => { res.json({ status: 'ok', version: APP_VERSION }); });

// --- SEO: robots.txt ---
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nSitemap: https://www.vapourware.ai/sitemap.xml\n'
  );
});

// --- SEO: sitemap.xml ---
let sitemapCache = null;
app.get('/sitemap.xml', (req, res) => {
  if (!sitemapCache) {
    const urls = ['  <url><loc>https://www.vapourware.ai/</loc></url>'];
    for (let b = 0; b < BOOKS.length; b++) {
      const slug = toSlug(BOOKS[b]);
      for (let c = 1; c <= CHAPTERS[b]; c++) {
        urls.push(`  <url><loc>https://www.vapourware.ai/${slug}/${c}</loc></url>`);
      }
    }
    sitemapCache = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + urls.join('\n') + '\n</urlset>';
  }
  res.setHeader('Cache-Control', CACHE_ONE_DAY);
  res.type('application/xml').send(sitemapCache);
});

// --- Fingerprinted static assets with immutable caching ---
app.get('/app.:hash.js', (req, res) => {
  if (req.params.hash !== JS_HASH) return res.status(404).end();
  res.setHeader('Cache-Control', CACHE_IMMUTABLE);
  res.type('js').send(JS_SRC);
});

app.get('/favicon.ico', (req, res) => {
  res.redirect(301, '/favicon.svg');
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- In-memory cache layer over disk ---
const memCache = new Map();
const etagCache = new Map(); // bookIndex:chapterKey → { body, etag }
const saveChains = new Map();
const chapterJobs = new Map();
const sectionJobs = new Map();

function safeDecodePath(p) {
  try { return decodeURIComponent(p); } catch { return null; }
}

function isAssetPath(p) {
  const last = p.split('/').pop() || '';
  return last.includes('.');
}

function seedRenderCache() {
  if (process.env.SEED_RENDER_CACHE === '0' || RENDERS_DIR === SOURCE_RENDERS_DIR) return;
  const totals = {
    files: 0,
    entriesAdded: 0,
    entriesReplaced: 0,
    entriesSkippedStaleSource: 0,
    entriesSkippedMalformed: 0,
  };
  try {
    for (const f of fs.readdirSync(SOURCE_RENDERS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const src = path.join(SOURCE_RENDERS_DIR, f);
      const dest = path.join(RENDERS_DIR, f);
      const sourceData = JSON.parse(fs.readFileSync(src, 'utf8'));
      let destData = {};
      let destFileMalformed = false;
      try {
        destData = JSON.parse(fs.readFileSync(dest, 'utf8'));
      } catch {
        destFileMalformed = fs.existsSync(dest);
      }
      const merged = mergeSeedRenderCache(sourceData, destData, RENDER_VERSION, { destFileMalformed });
      totals.entriesAdded += merged.entriesAdded;
      totals.entriesReplaced += merged.entriesReplaced;
      totals.entriesSkippedStaleSource += merged.entriesSkippedStaleSource;
      totals.entriesSkippedMalformed += merged.entriesSkippedMalformed;
      if (merged.changed) {
        fs.writeFileSync(dest, JSON.stringify(merged.cache, null, 2));
        totals.files++;
      }
    }
    const touched = totals.files
      + totals.entriesAdded
      + totals.entriesReplaced
      + totals.entriesSkippedStaleSource
      + totals.entriesSkippedMalformed;
    if (touched > 0) log.info('render_cache_seeded', { ...totals, dir: RENDERS_DIR });
  } catch (err) {
    log.error('render_cache_seed_failed', { err: err.message });
  }
}

seedRenderCache();

function loadCache(bookIndex) {
  if (memCache.has(bookIndex)) return memCache.get(bookIndex);
  const file = path.join(RENDERS_DIR, `${bookIndex}.json`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = {}; }
  memCache.set(bookIndex, data);
  return data;
}

function saveCache(bookIndex, cache) {
  memCache.set(bookIndex, cache);
  // Invalidate pre-computed ETags for this book
  for (const key of etagCache.keys()) {
    if (key.startsWith(bookIndex + ':')) etagCache.delete(key);
  }
  const file = path.join(RENDERS_DIR, `${bookIndex}.json`);
  const tmp = file + `.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  const body = JSON.stringify(cache, null, 2);
  const previous = saveChains.get(bookIndex) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      await fs.promises.mkdir(RENDERS_DIR, { recursive: true });
      await fs.promises.writeFile(tmp, body);
      await fs.promises.rename(tmp, file);
    });
  const tracked = next.finally(() => {
    if (saveChains.get(bookIndex) === tracked) saveChains.delete(bookIndex);
  });
  saveChains.set(bookIndex, tracked);
  tracked.catch(err => log.error('cache_write_failed', { book: bookIndex, err: err.message }));
  return tracked;
}

// --- Shared helpers ---

function resolveChapter(bookSlug, chapterStr) {
  const bookName = bookSlug.replace(/-/g, ' ');
  const bookIndex = BOOKS_LOWER.indexOf(bookName.toLowerCase());
  if (bookIndex === -1) return null;
  if (!/^\d+$/.test(chapterStr)) return null;
  const chNum = Number(chapterStr);
  if (!Number.isFinite(chNum) || chNum < 1) return null;
  const verseCount = VERSES[bookIndex]?.[chNum - 1];
  if (!verseCount) return null;
  return { bookIndex, bookName: BOOKS[bookIndex], chNum, verseCount };
}

function getChapterVerses(bookIndex, chNum) {
  const cache = loadCache(bookIndex);
  const verseCount = VERSES[bookIndex][chNum - 1];
  const verses = Array(verseCount).fill(null);
  const missing = [];
  for (let v = 0; v < verseCount; v++) {
    const entry = cache[`${chNum - 1}:${v}`];
    if (entry && entry.v === RENDER_VERSION) {
      verses[v] = { rendering: entry.rendering, note: entry.note };
    } else {
      missing.push(v);
    }
  }
  return { cache, verses, missing };
}

function cacheEntryIsCurrent(location) {
  const cache = loadCache(location.bookIndex);
  const entry = cache[`${location.chapter - 1}:${location.verse - 1}`];
  return Boolean(entry && entry.v === RENDER_VERSION);
}

function missingSectionRefs(section) {
  return (section.targetReferences || section.references || [])
    .filter(ref => !cacheEntryIsCurrent(parseRef(ref)));
}

async function writeSectionEntriesToCache(entries) {
  const touched = new Map();
  const now = Date.now();
  for (const entry of entries) {
    const location = parseRef(entry.ref);
    const cache = loadCache(location.bookIndex);
    cache[`${location.chapter - 1}:${location.verse - 1}`] = {
      rendering: entry.rendering,
      note: entry.note,
      noteKind: entry.noteKind,
      christConnection: entry.christConnection,
      v: RENDER_VERSION,
      t: now,
    };
    touched.set(location.bookIndex, cache);
  }
  await Promise.all([...touched.entries()].map(([bookIndex, cache]) => saveCache(bookIndex, cache)));
  return touched.size;
}

function getRenderPriority(req) {
  const render = String(req.query.render || '1').toLowerCase();
  if (render === '0' || render === 'false' || render === 'cache-only') return null;
  const priority = String(req.query.priority || render || RENDER_PRIORITY_FOREGROUND).toLowerCase();
  return priority === RENDER_PRIORITY_BACKGROUND || priority === 'low'
    ? RENDER_PRIORITY_BACKGROUND
    : RENDER_PRIORITY_FOREGROUND;
}

// --- Verse rendering with retry ---
const RENDER_RETRIES = 2;
const RETRY_BASE_MS = 1000;

function createPrioritySemaphore(limit, hasForegroundWork) {
  let active = 0;
  const queue = [];
  const priorityOf = job => job?.priority || RENDER_PRIORITY_FOREGROUND;

  function drain() {
    while (active < limit && queue.length > 0) {
      let nextIndex = queue.findIndex(item => priorityOf(item.job) === RENDER_PRIORITY_FOREGROUND);
      if (nextIndex === -1) {
        if (hasForegroundWork()) return;
        nextIndex = 0;
      }
      const [next] = queue.splice(nextIndex, 1);
      active++;
      next.resolve();
    }
  }

  function acquire(job) {
    return new Promise(resolve => {
      queue.push({ job, resolve });
      drain();
    });
  }
  async function run(fn, job) {
    const queuedAt = Date.now();
    await acquire(job);
    const queueMs = Date.now() - queuedAt;
    try {
      return await fn(queueMs);
    } finally {
      active--;
      drain();
    }
  }
  return { run, drain };
}

let foregroundRenderJobs = 0;
const renderSlots = createPrioritySemaphore(RENDER_CONCURRENCY, () => foregroundRenderJobs > 0);

function trackForegroundJob(job) {
  if (job.priority === RENDER_PRIORITY_FOREGROUND && !job.foregroundTracked) {
    job.foregroundTracked = true;
    foregroundRenderJobs++;
    renderSlots.drain();
  }
}

function finishRenderJob(job) {
  if (job.foregroundTracked) {
    foregroundRenderJobs--;
    job.foregroundTracked = false;
    renderSlots.drain();
  }
}

async function renderVerse(book, chapter, verse, job) {
  const verseStarted = Date.now();
  for (let attempt = 0; attempt <= RENDER_RETRIES; attempt++) {
    const attemptStarted = Date.now();
    try {
      return await renderSlots.run(async queueMs => {
        const apiStarted = Date.now();
        try {
          const rendered = await renderVerseOnce(book, chapter, verse);
          return {
            ...rendered,
            timing: {
              attempts: attempt + 1,
              queueMs,
              apiMs: Date.now() - apiStarted,
              verseMs: Date.now() - verseStarted,
            },
          };
        } catch (err) {
          err.renderTiming = {
            attempts: attempt + 1,
            queueMs,
            apiMs: Date.now() - apiStarted,
            durationMs: Date.now() - attemptStarted,
            totalVerseMs: Date.now() - verseStarted,
          };
          throw err;
        }
      }, job);
    }
    catch (err) {
      if (attempt === RENDER_RETRIES) throw err;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      const timing = err.renderTiming || {};
      log.warn('verse_render_retry', {
        book,
        chapter,
        verse,
        attempt: attempt + 1,
        delay,
        durationMs: Date.now() - attemptStarted,
        queueMs: timing.queueMs,
        apiMs: timing.apiMs,
        totalVerseMs: Date.now() - verseStarted,
        err: err.message,
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function renderVerseOnce(book, chapter, verse) {
  const ref = `${book} ${chapter}:${verse}`;
  const r = await fetch(XAI_API_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({
      model: RENDER_MODEL,
      reasoning_effort: RENDER_REASONING_EFFORT,
      store: false,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: ref }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'verse_rendering',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              rendering: { type: 'string', description: 'A modern English rendering of the verse, translated with care for the original Hebrew/Aramaic/Greek.' },
              note: { type: 'string', description: 'A curious note that MUST be shorter in character count than the rendering. 1-2 sentences max.' },
            },
            required: ['rendering', 'note'],
            additionalProperties: false,
          },
        },
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || 'render failed');
  const raw = data.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw new Error('unexpected API response shape');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('api_json_malformed', { book, chapter, verse, raw: raw.slice(0, 200) });
    throw new Error('malformed JSON from API');
  }
  if (typeof parsed.rendering !== 'string' || typeof parsed.note !== 'string') {
    throw new Error('malformed verse rendering');
  }
  parsed.rendering = cleanText(parsed.rendering);
  parsed.note = cleanText(parsed.note);
  // Model quality feedback: note should be shorter than rendering
  if (parsed.note.length >= parsed.rendering.length) {
    log.debug('note_too_long', { book, chapter, verse, noteLen: parsed.note.length, renderLen: parsed.rendering.length });
  }
  return parsed;
}

async function renderSection(book, chapter, section, job) {
  const sectionStarted = Date.now();
  for (let attempt = 0; attempt <= RENDER_RETRIES; attempt++) {
    const attemptStarted = Date.now();
    try {
      return await renderSlots.run(async queueMs => {
        const apiStarted = Date.now();
        try {
          const entries = await renderSectionOnce({
            apiUrl: XAI_API_URL,
            apiKey: XAI_API_KEY,
            model: RENDER_MODEL,
            reasoningEffort: RENDER_REASONING_EFFORT,
            bookName: book,
            chapter,
            section,
          });
          return {
            entries: entries.map(entry => ({
              ...entry,
              rendering: cleanText(entry.rendering),
              note: cleanText(entry.note),
            })),
            timing: {
              attempts: attempt + 1,
              queueMs,
              apiMs: Date.now() - apiStarted,
              verseMs: Date.now() - sectionStarted,
            },
          };
        } catch (err) {
          err.renderTiming = {
            attempts: attempt + 1,
            queueMs,
            apiMs: Date.now() - apiStarted,
            durationMs: Date.now() - attemptStarted,
            totalVerseMs: Date.now() - sectionStarted,
          };
          throw err;
        }
      }, job);
    }
    catch (err) {
      if (attempt === RENDER_RETRIES) throw err;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      const timing = err.renderTiming || {};
      log.warn('section_render_retry', {
        book,
        chapter,
        sectionId: section.id,
        sectionRef: sectionRef(section),
        targetRefs: (section.targetReferences || section.references || []).length,
        attempt: attempt + 1,
        delay,
        durationMs: Date.now() - attemptStarted,
        queueMs: timing.queueMs,
        apiMs: timing.apiMs,
        totalVerseMs: Date.now() - sectionStarted,
        err: err.message,
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function renderSectionAndCache(section, job) {
  const missingRefs = missingSectionRefs(section);
  if (missingRefs.length === 0) {
    return { entries: [], skipped: true, timing: null };
  }
  const result = await renderSection(section.book, section.chapter, section, job);
  const cacheFiles = await writeSectionEntriesToCache(result.entries);
  return {
    ...result,
    cacheFiles,
    skipped: false,
  };
}

function sectionJobKey(section) {
  return section.id || sectionRef(section);
}

function promoteSectionJob(job) {
  if (!job) return;
  job.priority = RENDER_PRIORITY_FOREGROUND;
  trackForegroundJob(job);
}

function queueSectionRender(section, priority) {
  const key = sectionJobKey(section);
  const existing = sectionJobs.get(key);
  if (existing) {
    if (priority === RENDER_PRIORITY_FOREGROUND && existing.priority !== RENDER_PRIORITY_FOREGROUND) {
      promoteSectionJob(existing);
      return { status: 'promoted', promise: existing.promise };
    }
    return { status: 'inflight', promise: existing.promise };
  }
  const job = { priority, sectionId: key };
  trackForegroundJob(job);
  job.promise = renderSectionAndCache(section, job)
    .catch(err => {
      err.section = section;
      throw err;
    })
    .finally(() => {
      finishRenderJob(job);
      sectionJobs.delete(key);
    });
  sectionJobs.set(key, job);
  return {
    status: priority === RENDER_PRIORITY_BACKGROUND ? 'started-background' : 'started',
    promise: job.promise,
  };
}

function avgMs(values) {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, n) => sum + n, 0) / values.length);
}

function percentileMs(values, percentile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * percentile) - 1);
  return Math.round(sorted[index]);
}

function maxMs(values) {
  if (values.length === 0) return 0;
  return Math.round(Math.max(...values));
}

function timingValues(timings, key) {
  return timings
    .map(t => t?.[key])
    .filter(n => typeof n === 'number' && Number.isFinite(n));
}

function summarizeRenderTimings(timings) {
  const verseMs = timingValues(timings, 'verseMs');
  const queueMs = timingValues(timings, 'queueMs');
  const apiMs = timingValues(timings, 'apiMs');
  return {
    avgVerseMs: avgMs(verseMs),
    p95VerseMs: percentileMs(verseMs, 0.95),
    maxVerseMs: maxMs(verseMs),
    avgQueueMs: avgMs(queueMs),
    avgApiMs: avgMs(apiMs),
    maxApiMs: maxMs(apiMs),
  };
}

async function renderMissingChapterV1(ref, requestedMissing, job) {
  const { bookIndex, bookName, chNum } = ref;
  const cache = loadCache(bookIndex);
  const missing = requestedMissing.filter(v => {
    const entry = cache[`${chNum - 1}:${v}`];
    return !entry || entry.v !== RENDER_VERSION;
  });
  if (missing.length === 0) {
    finishRenderJob(job);
    return;
  }

  const startedAt = Date.now();
  log.info('chapter_render_started', {
    book: bookName,
    ch: chNum,
    missing: missing.length,
    priority: job.priority,
    renderConcurrency: RENDER_CONCURRENCY,
  });
  let rendered = 0;
  let failed = 0;
  let batches = 0;
  const timings = [];
  try {
    for (let i = 0; i < missing.length; i += RENDER_CONCURRENCY) {
      batches++;
      const batch = missing.slice(i, i + RENDER_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(v => renderVerse(bookName, chNum, v + 1, job).then(r => ({ v, r })))
      );
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          const { v, r } = result.value;
          cache[`${chNum - 1}:${v}`] = { rendering: r.rendering, note: r.note, v: RENDER_VERSION, t: Date.now() };
          if (r.timing) timings.push(r.timing);
          rendered++;
        } else {
          failed++;
          const timing = result.reason?.renderTiming || {};
          timings.push({
            verseMs: timing.totalVerseMs,
            queueMs: timing.queueMs,
            apiMs: timing.apiMs,
          });
          log.warn('verse_render_failed', {
            book: bookName,
            ch: chNum,
            verse: batch[j] + 1,
            reason: result.reason?.message || String(result.reason),
            attempts: timing.attempts,
            durationMs: timing.durationMs,
            queueMs: timing.queueMs,
            apiMs: timing.apiMs,
            totalVerseMs: timing.totalVerseMs,
          });
        }
      }
      await saveCache(bookIndex, cache);
    }
  } finally {
    finishRenderJob(job);
  }
  log.info('chapter_render_finished', {
    book: bookName,
    ch: chNum,
    durationMs: Date.now() - startedAt,
    rendered,
    failed,
    missing: missing.length,
    batches,
    ...summarizeRenderTimings(timings),
  });
}

async function renderMissingChapterV2(ref, requestedMissing, job) {
  const { bookIndex, bookName, chNum } = ref;
  const cache = loadCache(bookIndex);
  const missing = requestedMissing.filter(v => {
    const entry = cache[`${chNum - 1}:${v}`];
    return !entry || entry.v !== RENDER_VERSION;
  });
  if (missing.length === 0) {
    finishRenderJob(job);
    return;
  }

  const sections = groupMissingVersesIntoSections(bookName, chNum, missing)
    .filter(section => missingSectionRefs(section).length > 0);
  if (sections.length === 0) {
    finishRenderJob(job);
    return;
  }
  const startedAt = Date.now();
  log.info('chapter_render_started', {
    book: bookName,
    ch: chNum,
    missing: missing.length,
    priority: job.priority,
    renderConcurrency: RENDER_CONCURRENCY,
    renderPipeline: RENDER_PIPELINE,
    sections: sections.length,
  });
  let rendered = 0;
  let failed = 0;
  let batches = 0;
  const timings = [];
  try {
    for (let i = 0; i < sections.length; i += RENDER_CONCURRENCY) {
      batches++;
      const batch = sections.slice(i, i + RENDER_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(section => {
          const queued = queueSectionRender(section, job.priority);
          if (!job.sectionIds) job.sectionIds = new Set();
          job.sectionIds.add(sectionJobKey(section));
          return queued.promise.then(r => ({ section, r, status: queued.status }));
        })
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { r } = result.value;
          rendered += r.entries.length;
          if (r.timing) timings.push(r.timing);
        } else {
          const section = result.reason?.section;
          const timing = result.reason?.renderTiming || {};
          const targetCount = (section?.targetReferences || section?.references || []).length;
          failed += targetCount || 1;
          timings.push({
            verseMs: timing.totalVerseMs,
            queueMs: timing.queueMs,
            apiMs: timing.apiMs,
          });
          log.warn('section_render_failed', {
            book: bookName,
            ch: chNum,
            sectionId: section?.id,
            sectionRef: section ? sectionRef(section) : undefined,
            targetRefs: targetCount,
            reason: result.reason?.message || String(result.reason),
            attempts: timing.attempts,
            durationMs: timing.durationMs,
            queueMs: timing.queueMs,
            apiMs: timing.apiMs,
            totalVerseMs: timing.totalVerseMs,
          });
        }
      }
    }
  } finally {
    finishRenderJob(job);
  }
  log.info('chapter_render_finished', {
    book: bookName,
    ch: chNum,
    durationMs: Date.now() - startedAt,
    rendered,
    failed,
    missing: missing.length,
    batches,
    renderPipeline: RENDER_PIPELINE,
    sections: sections.length,
    ...summarizeRenderTimings(timings),
  });
}

async function renderMissingChapter(ref, requestedMissing, job) {
  if (RENDER_PIPELINE === RENDER_PIPELINE_V2) {
    return renderMissingChapterV2(ref, requestedMissing, job);
  }
  return renderMissingChapterV1(ref, requestedMissing, job);
}

function queueChapterRender(ref, missing, priority) {
  const key = `${ref.bookIndex}:${ref.chNum}`;
  const existing = chapterJobs.get(key);
  if (existing) {
    if (priority === RENDER_PRIORITY_FOREGROUND && existing.priority !== RENDER_PRIORITY_FOREGROUND) {
      existing.priority = RENDER_PRIORITY_FOREGROUND;
      trackForegroundJob(existing);
      for (const sectionId of existing.sectionIds || []) promoteSectionJob(sectionJobs.get(sectionId));
      return 'promoted';
    }
    return 'inflight';
  }
  const job = { priority };
  trackForegroundJob(job);
  job.promise = renderMissingChapter(ref, missing, job)
    .catch(err => log.error('chapter_render_failed', { book: ref.bookName, ch: ref.chNum, err: err.message }))
    .finally(() => chapterJobs.delete(key));
  chapterJobs.set(key, job);
  return priority === RENDER_PRIORITY_BACKGROUND ? 'started-background' : 'started';
}

app.get('/api/chapter/:book/:chapter', async (req, res) => {
  const ref = resolveChapter(req.params.book, req.params.chapter);
  if (!ref) return res.status(400).json({ error: 'invalid book or chapter' });
  const { bookIndex, bookName, chNum } = ref;

  let { verses, missing } = getChapterVerses(bookIndex, chNum);
  if (missing.length > 0) {
    const renderPriority = getRenderPriority(req);
    const renderStatus = renderPriority
      ? queueChapterRender({ bookIndex, bookName, chNum }, missing, renderPriority)
      : 'skipped';
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      verses,
      complete: false,
      missingCount: missing.length,
      retryAfterMs: PARTIAL_RETRY_MS,
      renderQueued: renderStatus,
      renderPriority: renderPriority || 'none',
    });
  }

  const body = JSON.stringify({ verses, complete: true, missingCount: 0 });

  // Cache fully-rendered chapters with pre-computed ETag
  const allRendered = !verses.includes(null) && verses.length > 0;
  if (allRendered) {
    const cacheKey = `${bookIndex}:${chNum}`;
    let cached = etagCache.get(cacheKey);
    if (!cached || cached.body !== body) {
      const etag = '"' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 16) + '"';
      cached = { body, etag };
      etagCache.set(cacheKey, cached);
    }
    res.setHeader('Cache-Control', CACHE_ONE_DAY);
    res.setHeader('ETag', cached.etag);
    if (req.headers['if-none-match'] === cached.etag) {
      return res.status(304).end();
    }
  }

  res.type('json').send(body);
});

app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', CACHE_ONE_DAY);
  res.json({
    version: RENDER_VERSION,
    model: RENDER_MODEL,
    reasoningEffort: RENDER_REASONING_EFFORT,
    renderPipeline: RENDER_PIPELINE,
    promptVersion: RENDER_PIPELINE === RENDER_PIPELINE_V2 ? V2_PROMPT_VERSION : 'inline-v1',
    schemaVersion: RENDER_PIPELINE === RENDER_PIPELINE_V2 ? V2_SCHEMA_VERSION : 'verse-v1',
    sectionVersion: RENDER_PIPELINE === RENDER_PIPELINE_V2 ? SECTIONS_VERSION : null,
    appVersion: APP_VERSION,
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

const CONFIG_JSON = JSON.stringify({ books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION, v: APP_VERSION }).replace(/<\//g, '<\\/');
const INDEX_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('__APP_VERSION__', APP_VERSION)
  .replace('__CONFIG__', CONFIG_JSON)
  .replace('<link rel="stylesheet" href="/style.css">', '<style>' + CSS_SRC + '</style>');
let INDEX_HTML;

const DEFAULT_DESC = 'The Bible rendered in modern English. Every verse, every note, illuminated.';
const ORIGIN = 'https://www.vapourware.ai';

function buildJsonLd(bookName, chNum, slug, canonical) {
  if (!bookName) {
    return JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'vapourware.ai',
      url: ORIGIN,
      description: DEFAULT_DESC,
    });
  }
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    name: bookName + ' ' + chNum,
    url: canonical,
    isPartOf: { '@type': 'Book', name: 'The Bible' },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: ORIGIN + '/' },
        { '@type': 'ListItem', position: 2, name: bookName, item: ORIGIN + '/' + slug + '/1' },
        { '@type': 'ListItem', position: 3, name: 'Chapter ' + chNum },
      ],
    },
  });
}

app.get('{*path}', (req, res) => {
  // Redirect root visits to remembered chapter
  const rawPath = safeDecodePath(req.path);
  if (rawPath === null) return res.redirect(302, DEFAULT_PATH);
  if (isAssetPath(rawPath)) return res.status(404).end();
  const pathParts = rawPath.split('/').filter(Boolean);
  if (pathParts.length === 0) {
    const lastPos = parseCookie(req.headers.cookie, 'lastPos');
    if (lastPos) {
      const [biStr, chStr] = lastPos.split(':');
      const bi = parseInt(biStr);
      const ch = parseInt(chStr);
      if (Number.isFinite(bi) && bi >= 0 && bi < BOOKS.length
          && Number.isFinite(ch) && ch >= 0 && ch < CHAPTERS[bi]) {
        return res.redirect(302, '/' + toSlug(BOOKS[bi]) + '/' + (ch + 1));
      }
    }
    return res.redirect(302, DEFAULT_PATH);
  }

  let title = 'vapourware.ai';
  let ogTitle = 'vapourware.ai';
  let desc = DEFAULT_DESC;
  let canonical = ORIGIN;
  let preloadData = '';
  let jsonLd = buildJsonLd();
  try {
    const parts = pathParts;
    if (parts.length === 2) {
      const ref = resolveChapter(parts[0], parts[1]);
      if (ref) {
        const { bookIndex, bookName, chNum } = ref;
        const slug = parts[0].toLowerCase();
        title = bookName + ' ' + chNum;
        ogTitle = bookName + ' ' + chNum;
        canonical = ORIGIN + '/' + slug + '/' + chNum;
        jsonLd = buildJsonLd(bookName, chNum, slug, canonical);
        // Pull chapter data from cache
        const { verses, missing } = getChapterVerses(bookIndex, chNum);
        if (missing.length === 0 && verses.length > 0) {
          desc = verses[0].rendering;
          const payload = JSON.stringify({ book: bookName, ch: chNum, verses, complete: true, missingCount: 0 }).replace(/<\//g, '<\\/');
          preloadData = '<script id="preloaded" type="application/json">' + payload + '</script>';
        } else if (verses.some(Boolean)) {
          const payload = JSON.stringify({ book: bookName, ch: chNum, verses, complete: false, missingCount: missing.length }).replace(/<\//g, '<\\/');
          preloadData = '<script id="preloaded" type="application/json">' + payload + '</script>';
          desc = verses.find(Boolean)?.rendering || desc;
        } else {
          const cache = loadCache(bookIndex);
          const firstVerse = cache[`${chNum - 1}:0`];
          if (firstVerse && firstVerse.rendering && firstVerse.v === RENDER_VERSION) {
            desc = firstVerse.rendering;
          } else {
            desc = bookName + ' ' + chNum + ', rendered in modern English with scholarly notes.';
          }
        }
      } else {
        return res.redirect(302, DEFAULT_PATH);
      }
    } else {
      return res.redirect(302, DEFAULT_PATH);
    }
  } catch (e) { log.warn('path_parse_failed', { path: req.path, err: e.message }); }
  const html = INDEX_HTML
    .replace('<title>vapourware.ai</title>', '<title>' + escapeHtml(title) + '</title>')
    .replace(/__OG_TITLE__/g, escapeHtml(ogTitle))
    .replace(/__META_DESC__/g, escapeHtml(desc))
    .replace(/__CANONICAL__/g, escapeHtml(canonical))
    .replace('<!--PRELOAD_DATA-->', preloadData)
    .replace('<!--JSON_LD-->', '<script type="application/ld+json">' + jsonLd.replace(/<\//g, '<\\/') + '</script>');
  res.type('html').send(html);
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const pathName = req.path || '';
  if (err instanceof URIError) {
    if (pathName.startsWith('/api/')) return res.status(400).json({ error: 'bad request' });
    if (isAssetPath(pathName)) return res.status(404).end();
    return res.redirect(302, DEFAULT_PATH);
  }
  log.error('request_failed', { path: pathName, err: err.message });
  if (pathName.startsWith('/api/')) return res.status(500).json({ error: 'internal server error' });
  res.status(500).type('text').send('Internal server error');
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    const result = await minify(JS_RAW, {
      compress: true,
      mangle: true,
      format: { comments: /copyright/i },
    });
    if (result.code) {
      JS_SRC = result.code;
      log.info('js_minified', { from: JS_RAW.length, to: JS_SRC.length });
    }
  } catch (e) {
    log.warn('minify_failed', { err: e.message });
  }
  JS_HASH = crypto.createHash('sha256').update(JS_SRC).digest('hex').slice(0, 10);
  INDEX_HTML = INDEX_RAW
    .replace('src="/app.js"', `src="/app.${JS_HASH}.js"`)
    .replace('<!--PRELOAD-->', `<link rel="preload" href="/app.${JS_HASH}.js" as="script">`);
  app.listen(PORT, () => log.info('server_started', { port: PORT, version: APP_VERSION }));
})();
