const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

// --- Bible data ---
const { books: BOOKS, verses: VERSES } = require('./data/bible.json');
const CHAPTERS = VERSES.map(v => v.length);
const BOOKS_LOWER = BOOKS.map(b => b.toLowerCase());

// --- Constants ---
const API_TIMEOUT_MS = 30_000;
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';
const CACHE_ONE_DAY = 'public, max-age=86400';
const RENDER_CONCURRENCY = 8;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const RATE_CLEANUP_MS = 5 * 60_000;

// --- Asset fingerprinting ---
const CSS_SRC = fs.readFileSync(path.join(__dirname, 'public', 'style.css'), 'utf8');
const JS_RAW = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
let JS_SRC = JS_RAW;
let JS_HASH;

const app = express();
const XAI_API_KEY = process.env.XAI_API_KEY;
if (!XAI_API_KEY) { console.error('XAI_API_KEY env var is required'); process.exit(1); }
const RENDERS_DIR = path.join(__dirname, 'renders');
if (!fs.existsSync(RENDERS_DIR)) fs.mkdirSync(RENDERS_DIR);

const RENDER_MODEL = 'grok-4.20-0309-non-reasoning';
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
  .update(RENDER_MODEL + '\n' + SYSTEM_PROMPT)
  .digest('hex')
  .slice(0, 12);


function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replaceAll('vapor', 'vapour');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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

// --- Health check (before static, no compression overhead) ---
app.get('/health', (req, res) => { res.status(200).send('ok'); });

// --- Fingerprinted static assets with immutable caching ---
app.get('/app.:hash.js', (req, res) => {
  if (req.params.hash !== JS_HASH) return res.status(404).end();
  res.setHeader('Cache-Control', CACHE_IMMUTABLE);
  res.type('js').send(JS_SRC);
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// --- In-memory cache layer over disk ---
const memCache = new Map();
const etagCache = new Map(); // bookIndex:chapterKey → { body, etag }

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
  fs.promises.writeFile(
    path.join(RENDERS_DIR, `${bookIndex}.json`),
    JSON.stringify(cache, null, 2)
  ).catch(err => console.error('cache write failed:', err));
}

// --- Shared helpers ---

function resolveChapter(bookSlug, chapterStr) {
  const bookName = bookSlug.replace(/-/g, ' ');
  const bookIndex = BOOKS_LOWER.indexOf(bookName.toLowerCase());
  if (bookIndex === -1) return null;
  const chNum = parseInt(chapterStr);
  if (!Number.isFinite(chNum) || chNum < 1) return null;
  const verseCount = VERSES[bookIndex]?.[chNum - 1];
  if (!verseCount) return null;
  return { bookIndex, bookName: BOOKS[bookIndex], chNum, verseCount };
}

function getChapterVerses(bookIndex, chNum) {
  const cache = loadCache(bookIndex);
  const verseCount = VERSES[bookIndex][chNum - 1];
  const verses = [];
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

async function renderVerse(book, chapter, verse) {
  const ref = `${book} ${chapter}:${verse}`;
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${XAI_API_KEY}` },
    body: JSON.stringify({
      model: RENDER_MODEL,
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
  const parsed = JSON.parse(raw);
  if (typeof parsed.rendering !== 'string' || typeof parsed.note !== 'string') {
    throw new Error('malformed verse rendering');
  }
  parsed.rendering = cleanText(parsed.rendering);
  parsed.note = cleanText(parsed.note);
  return parsed;
}

// --- Rate limiting ---
const rateMap = new Map();

function rateLimit(req, res) {
  const ip = req.ip;
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT) {
    res.status(429).json({ error: 'too many requests' });
    return false;
  }
  return true;
}

// Clean stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, entry] of rateMap) {
    if (entry.start < cutoff) rateMap.delete(ip);
  }
}, RATE_CLEANUP_MS);

app.get('/api/chapter/:book/:chapter', async (req, res) => {
  if (!rateLimit(req, res)) return;

  const ref = resolveChapter(req.params.book, req.params.chapter);
  if (!ref) return res.status(400).json({ error: 'invalid book or chapter' });
  const { bookIndex, bookName, chNum } = ref;

  const { cache, verses, missing } = getChapterVerses(bookIndex, chNum);

  // Render missing verses in batches (limit concurrency to avoid API rate limits)
  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i += RENDER_CONCURRENCY) {
      const batch = missing.slice(i, i + RENDER_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(v => renderVerse(bookName, chNum, v + 1).then(r => ({ v, r })))
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const { v, r } = result.value;
          verses[v] = { rendering: r.rendering, note: r.note };
          cache[`${chNum - 1}:${v}`] = { rendering: r.rendering, note: r.note, v: RENDER_VERSION, t: Date.now() };
        }
      }
    }
    saveCache(bookIndex, cache);
  }

  const body = JSON.stringify({ verses });

  // Cache fully-rendered chapters with pre-computed ETag
  if (missing.length === 0) {
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
  res.json({ version: RENDER_VERSION, model: RENDER_MODEL });
});

const CONFIG_JSON = JSON.stringify({ books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION }).replace(/<\//g, '<\\/');
const INDEX_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('__CONFIG__', CONFIG_JSON)
  .replace('<link rel="stylesheet" href="/style.css">', '<style>' + CSS_SRC + '</style>');
let INDEX_HTML;

const DEFAULT_DESC = 'The Bible rendered in modern English. Every verse, every note, illuminated.';
const ORIGIN = 'https://www.vapourware.ai';

app.get('{*path}', (req, res) => {
  let title = 'vapourware.ai';
  let ogTitle = 'vapourware.ai';
  let desc = DEFAULT_DESC;
  let canonical = ORIGIN;
  let preloadData = '';
  try {
    const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
    if (parts.length === 2) {
      const ref = resolveChapter(parts[0], parts[1]);
      if (ref) {
        const { bookIndex, bookName, chNum } = ref;
        title = bookName + ' ' + chNum;
        ogTitle = bookName + ' ' + chNum;
        canonical = ORIGIN + '/' + parts[0].toLowerCase() + '/' + chNum;
        // Pull chapter data from cache
        const { verses, missing } = getChapterVerses(bookIndex, chNum);
        if (missing.length === 0 && verses.length > 0) {
          desc = verses[0].rendering;
          const payload = JSON.stringify({ book: bookName, ch: chNum, verses }).replace(/<\//g, '<\\/');
          preloadData = '<script id="preloaded" type="application/json">' + payload + '</script>';
        } else {
          const cache = loadCache(bookIndex);
          const firstVerse = cache[`${chNum - 1}:0`];
          if (firstVerse && firstVerse.rendering && firstVerse.v === RENDER_VERSION) {
            desc = firstVerse.rendering;
          } else {
            desc = bookName + ' ' + chNum + ', rendered in modern English with scholarly notes.';
          }
        }
      }
    }
  } catch {}
  const html = INDEX_HTML
    .replace('<title>vapourware.ai</title>', '<title>' + escapeHtml(title) + '</title>')
    .replace(/__OG_TITLE__/g, escapeHtml(ogTitle))
    .replace(/__META_DESC__/g, escapeHtml(desc))
    .replace(/__CANONICAL__/g, escapeHtml(canonical))
    .replace('<!--PRELOAD_DATA-->', preloadData);
  res.type('html').send(html);
});

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    const result = await minify(JS_RAW, { compress: true, mangle: true });
    if (result.code) {
      JS_SRC = result.code;
      console.log(`JS minified: ${JS_RAW.length} → ${JS_SRC.length} bytes`);
    }
  } catch (e) {
    console.warn('JS minification failed, serving unminified:', e.message);
  }
  JS_HASH = crypto.createHash('sha256').update(JS_SRC).digest('hex').slice(0, 10);
  INDEX_HTML = INDEX_RAW
    .replace('src="/app.js"', `src="/app.${JS_HASH}.js"`)
    .replace('<!--PRELOAD-->', `<link rel="preload" href="/app.${JS_HASH}.js" as="script">`);
  app.listen(PORT, () => console.log(`vapourware.ai → http://localhost:${PORT}`));
})();
