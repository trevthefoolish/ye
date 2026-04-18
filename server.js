// Copyright (c) 2026 vapourware.ai All rights reserved.
const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');
const { log, parseCookie, POSTHOG_KEY } = require('./logger');
const createRateLimiter = require('./rateLimit');

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
if (!XAI_API_KEY) { log.error('missing_api_key'); process.exit(1); }
process.on('unhandledRejection', reason => log.error('unhandled_rejection', { err: String(reason) }));
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

function toSlug(name) { return name.toLowerCase().replace(/ /g, '-'); }

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://us-assets.i.posthog.com; connect-src 'self' https://us.i.posthog.com; style-src 'self' 'unsafe-inline'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(compression());

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
  ).catch(err => log.error('cache_write_failed', { book: bookIndex, err: err.message }));
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

// --- Verse rendering with retry ---
const RENDER_RETRIES = 2;
const RETRY_BASE_MS = 1000;

async function renderVerse(book, chapter, verse) {
  for (let attempt = 0; attempt <= RENDER_RETRIES; attempt++) {
    try { return await renderVerseOnce(book, chapter, verse); }
    catch (err) {
      if (attempt === RENDER_RETRIES) throw err;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      log.warn('verse_render_retry', { book, chapter, verse, attempt: attempt + 1, delay, err: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function renderVerseOnce(book, chapter, verse) {
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
    log.warn('note_too_long', { book, chapter, verse, noteLen: parsed.note.length, renderLen: parsed.rendering.length });
  }
  return parsed;
}

// --- Rate limiting ---
const checkApiRate = createRateLimiter(RATE_WINDOW_MS, RATE_LIMIT, RATE_CLEANUP_MS);

function rateLimit(req, res) {
  if (!checkApiRate(req.ip)) {
    res.status(429).json({ error: 'too many requests' });
    return false;
  }
  return true;
}

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
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          const { v, r } = result.value;
          verses[v] = { rendering: r.rendering, note: r.note };
          cache[`${chNum - 1}:${v}`] = { rendering: r.rendering, note: r.note, v: RENDER_VERSION, t: Date.now() };
        } else {
          log.warn('verse_render_failed', { book: bookName, ch: chNum, verse: batch[j] + 1, reason: result.reason?.message || String(result.reason) });
        }
      }
    }
    saveCache(bookIndex, cache);
  }

  const body = JSON.stringify({ verses });

  // Cache fully-rendered chapters with pre-computed ETag
  const allRendered = !verses.includes(undefined) && verses.length > 0;
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
  res.json({ version: RENDER_VERSION, model: RENDER_MODEL, appVersion: APP_VERSION });
});

const CONFIG_JSON = JSON.stringify({ books: BOOKS, chapters: CHAPTERS, rv: RENDER_VERSION, v: APP_VERSION }).replace(/<\//g, '<\\/');
const INDEX_RAW = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('__APP_VERSION__', APP_VERSION)
  .replace('__CONFIG__', CONFIG_JSON)
  .replace('__POSTHOG_KEY__', POSTHOG_KEY)
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
  const rawPath = decodeURIComponent(req.path);
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
  }

  let title = 'vapourware.ai';
  let ogTitle = 'vapourware.ai';
  let desc = DEFAULT_DESC;
  let canonical = ORIGIN;
  let preloadData = '';
  let jsonLd = buildJsonLd();
  try {
    const parts = pathParts.length ? pathParts : decodeURIComponent(req.path).split('/').filter(Boolean);
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
