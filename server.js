const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
- 1-2 sentences. Think "fascinating tidbit" not "mini sermon"
- Sound like BibleProject — curious, accessible, connecting dots across the biblical story
- Draw on any of these angles: wordplay in the original language, intertextual echoes, ancient cultural context, the verse's place in the unified narrative, wisdom for character formation, or its connection to Jesus
- Show how this verse connects to the Bible's larger themes and narrative patterns (e.g. exile/return, heaven-and-earth overlap, image of God, covenant faithfulness)
- When a key Hebrew/Aramaic/Greek word unlocks something surprising, mention it — but as a discovery, not a lecture
- When the verse naturally connects forward to Jesus or the New Testament, trace that thread. When it doesn't, let it stand within its own context in the story
- Don't moralize or apply. Just illuminate what's going on in the text and why it matters in the bigger story
</note-guidelines>`;

const RENDER_VERSION = crypto
  .createHash('sha256')
  .update(RENDER_MODEL + '\n' + SYSTEM_PROMPT)
  .digest('hex')
  .slice(0, 12);

const BOOKS = [
  'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth',
  '1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles',
  'Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes',
  'Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel',
  'Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk',
  'Zephaniah','Haggai','Zechariah','Malachi',
  'Matthew','Mark','Luke','John','Acts','Romans',
  '1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians',
  'Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy',
  'Titus','Philemon','Hebrews','James','1 Peter','2 Peter',
  '1 John','2 John','3 John','Jude','Revelation'
];

const VERSES = [
  [31,25,24,26,32,22,24,22,29,32,32,20,18,24,21,16,27,33,38,18,34,24,20,67,34,35,46,22,35,43,55,32,20,31,29,43,36,30,23,23,57,38,34,34,28,34,31,22,33,26],
  [22,25,22,31,23,30,25,32,35,29,10,51,22,31,27,36,16,27,25,26,36,31,33,18,40,37,21,43,46,38,18,35,23,35,35,38,29,31,43,38],
  [17,16,17,35,19,30,38,36,24,20,47,8,59,57,33,34,16,30,37,27,24,33,44,23,55,46,34],
  [54,34,51,49,31,27,89,26,23,36,35,16,33,45,41,50,13,32,22,29,35,41,30,25,18,65,23,31,40,16,54,42,56,29,34,13],
  [46,37,29,49,33,25,26,20,29,22,32,32,18,29,23,22,20,22,21,20,23,30,25,22,19,19,26,68,29,20,30,52,29,12],
  [18,24,17,24,15,27,26,35,27,43,23,24,33,15,63,10,18,28,51,9,45,34,16,33],
  [36,23,31,24,31,40,25,35,57,18,40,15,25,20,20,31,13,31,30,48,25],
  [22,23,18,22],
  [28,36,21,22,12,21,17,22,27,27,15,25,23,52,35,23,58,30,24,42,15,23,29,22,44,25,12,25,11,31,13],
  [27,32,39,12,25,23,29,18,13,19,27,31,39,33,37,23,29,33,43,26,22,51,39,25],
  [53,46,28,34,18,38,51,66,28,29,43,33,34,31,34,34,24,46,21,43,29,53],
  [18,25,27,44,27,33,20,29,37,36,21,21,25,29,38,20,41,37,37,21,26,20,37,20,30],
  [54,55,24,43,26,81,40,40,44,14,47,40,14,17,29,43,27,17,19,8,30,19,32,31,31,32,34,21,30],
  [17,18,17,22,14,42,22,18,31,19,23,16,22,15,19,14,19,34,11,37,20,12,21,27,28,23,9,27,36,27,21,33,25,33,27,23],
  [11,70,13,24,17,22,28,36,15,44],
  [11,20,32,23,19,19,73,18,38,39,36,47,31],
  [22,23,15,17,14,14,10,17,32,3],
  [22,13,26,21,27,30,21,22,35,22,20,25,28,22,35,22,16,21,29,29,34,30,17,25,6,14,23,28,25,31,40,22,33,37,16,33,24,41,30,24,34,17],
  [6,12,8,8,12,10,17,9,20,18,7,8,6,7,5,11,15,50,14,9,13,31,6,10,22,12,14,9,11,12,24,11,22,22,28,12,40,22,13,17,13,11,5,26,17,11,9,14,20,23,19,9,6,7,23,13,11,11,17,12,8,12,11,10,13,20,7,35,36,5,24,20,28,23,10,12,20,72,13,19,16,8,18,12,13,17,7,18,52,17,16,15,5,23,11,13,12,9,9,5,8,28,22,35,45,48,43,13,31,7,10,10,9,8,18,19,2,29,176,7,8,9,4,8,5,6,5,6,8,8,3,18,3,3,21,26,9,8,24,13,10,7,12,15,21,10,20,14,9,6],
  [33,22,35,27,23,35,27,36,18,32,31,28,25,35,33,33,28,24,29,30,31,31,29,22,25,28,25,29,28,30,31],
  [18,26,22,16,20,12,29,17,18,20,10,14],
  [17,17,11,16,16,13,13,14],
  [31,22,26,6,30,13,25,22,21,34,16,6,22,32,9,14,14,7,25,6,17,25,18,23,12,21,13,29,24,33,9,20,24,17,10,22,38,22,8,31,29,25,28,28,25,13,15,22,26,11,23,15,12,17,13,12,21,14,21,22,11,12,19,12,25,24],
  [19,37,25,31,31,30,34,22,26,25,23,17,27,22,21,21,27,23,15,18,14,30,40,10,38,24,22,17,32,24,40,44,26,22,19,32,21,28,18,16,18,22,13,30,5,28,7,47,39,46,64,34],
  [22,22,66,22,22],
  [28,10,27,17,17,14,27,18,11,22,25,28,23,23,8,63,24,32,14,49,32,31,49,27,17,21,36,26,21,26,18,32,33,31,15,38,28,23,29,49,26,20,27,31,25,24,23,35],
  [21,49,30,37,31,28,28,27,27,21,45,13],
  [11,23,5,19,15,11,16,14,17,15,12,14,16,9],
  [20,32,21],
  [15,16,15,13,27,14,17,14,15],
  [21],
  [17,10,10,11],
  [16,13,12,13,15,16,20],
  [15,13,19],
  [17,20,19],
  [18,15,20],
  [15,23],
  [21,13,10,14,11,15,14,23,17,12,17,14,9,21],
  [14,18,6,8],
  [25,23,17,25,48,34,29,34,38,42,30,50,58,36,39,28,27,35,30,34,46,46,39,51,46,75,66,20],
  [45,28,35,41,43,56,37,38,50,52,33,44,37,72,47,20],
  [80,52,38,44,39,49,50,56,62,42,54,59,35,35,32,31,37,43,48,47,38,71,56,53],
  [51,25,36,54,47,71,53,59,41,42,57,50,38,31,27,33,26,40,42,31,25],
  [26,47,26,37,42,15,60,40,43,48,30,25,52,28,41,40,34,28,41,38,40,30,35,27,27,32,44,31],
  [32,29,31,25,21,23,25,39,33,21,36,21,14,23,33,27],
  [31,16,23,21,13,20,40,13,27,33,34,31,13,40,58,24],
  [24,17,18,18,21,18,16,24,15,18,33,21,14],
  [24,21,29,31,26,18],
  [23,22,21,32,33,24],
  [30,30,21,23],
  [29,23,25,18],
  [10,20,13,18,28],
  [12,17,18],
  [20,15,16,16,25,21],
  [18,26,17,22],
  [16,15,15],
  [25],
  [14,18,19,16,14,20,28,13,28,39,40,29,25],
  [27,26,18,17,20],
  [25,25,22,19,14],
  [21,22,18],
  [10,29,24,21,21],
  [13],
  [14],
  [25],
  [20,29,22,11,14,17,17,13,21,11,19,17,18,20,8,21,18,24,21,15,27,21]
];

app.use(compression());
app.use(express.static(__dirname));

function loadCache(bookIndex) {
  const file = path.join(RENDERS_DIR, `${bookIndex}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function saveCache(bookIndex, cache) {
  fs.writeFileSync(path.join(RENDERS_DIR, `${bookIndex}.json`), JSON.stringify(cache, null, 2));
}

async function renderVerse(book, chapter, verse) {
  const ref = `${book} ${chapter}:${verse}`;
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
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
              note: { type: 'string', description: 'A short, curious note (1-2 sentences) connecting this verse to the Bible\'s larger themes and narrative patterns.' },
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
  const parsed = JSON.parse(data.choices[0].message.content);
  parsed.rendering = parsed.rendering.replaceAll('—', ', ').replaceAll('vapor', 'vapour');
  parsed.note = parsed.note.replaceAll('—', ', ').replaceAll('vapor', 'vapour');
  return parsed;
}

app.get('/api/chapter/:book/:chapter', async (req, res) => {
  const { book, chapter } = req.params;
  const bookIndex = BOOKS.indexOf(book);
  if (bookIndex === -1) return res.status(400).json({ error: 'unknown book' });
  const chNum = parseInt(chapter);
  const verseCount = VERSES[bookIndex]?.[chNum - 1];
  if (!verseCount) return res.status(400).json({ error: 'invalid chapter' });

  const cache = loadCache(bookIndex);
  const verses = [];
  const missing = [];

  for (let v = 0; v < verseCount; v++) {
    const key = `${chNum - 1}:${v}`;
    const entry = cache[key];
    if (entry && entry.v === RENDER_VERSION) {
      verses[v] = { rendering: entry.rendering, note: entry.note };
    } else {
      missing.push(v);
    }
  }

  // Render missing verses in parallel
  if (missing.length > 0) {
    const results = await Promise.allSettled(
      missing.map(v => renderVerse(book, chNum, v + 1).then(r => ({ v, r })))
    );
    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { v, r } = result.value;
        verses[v] = { rendering: r.rendering, note: r.note };
        cache[`${chNum - 1}:${v}`] = { rendering: r.rendering, note: r.note, v: RENDER_VERSION, t: Date.now() };
      }
    }
    saveCache(bookIndex, cache);
  }

  res.json({ verses: verses.filter(Boolean) });
});

app.get('/api/version', (req, res) => {
  res.json({ version: RENDER_VERSION, model: RENDER_MODEL });
});

const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const BOOKS_LOWER = BOOKS.map(b => b.toLowerCase());

app.get('{*path}', (req, res) => {
  const parts = decodeURIComponent(req.path).split('/').filter(Boolean);
  let title = 'vapourware.ai';
  if (parts.length === 2) {
    const bookName = parts[0].replace(/-/g, ' ');
    const ch = parseInt(parts[1]);
    const bi = BOOKS_LOWER.indexOf(bookName.toLowerCase());
    if (bi !== -1 && ch >= 1 && ch <= (VERSES[bi]?.length || 0)) {
      title = BOOKS[bi] + ' ' + ch;
    }
  }
  res.type('html').send(INDEX_HTML.replace('<title>vapourware.ai</title>', '<title>' + title + '</title>'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`vapourware.ai → http://localhost:${PORT}`));
