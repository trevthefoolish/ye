# vapourware.ai — Architectural Code Review

> Reviewed: 2026-04-01
> Codebase: `/Users/trev/Desktop/ye`
> Reviewer: Claude Sonnet 4.6

---

## TL;DR

This is an unusually well-considered piece of software for its size. The entire product is ~1,600 lines across 6 files with zero client-side dependencies, ships a 15KB minified JS bundle, and loads in 19ms at p50. The architecture is intentionally minimal and largely correct on its own terms. The most pressing issues are: a documentation drift in `agents.md`, a blocking first-render on uncached chapters, a rate-limiter that may be ineffective behind Railway's proxy, and a `cleanText` substring replacement that could mangle words containing 'vapor'.

---

## 1. Overall Architecture

**Runtime:** Node.js + Express 5 — no framework, no build toolchain, no TypeScript.

**Startup sequence (server.js):**
1. Read `bible.json` (4.6KB — just book names and verse counts, no text)
2. Read `style.css` and inline it directly into the HTML template
3. Read `app.js`, minify it with Terser, compute a content-hash fingerprint
4. Set up in-memory cache over disk renders, register routes
5. Start listening

**Per-request (catch-all route):**
- Parse URL slug → book + chapter
- If the chapter is fully cached, inject it as `<script id="preloaded" type="application/json">` in the HTML
- Inject OG tags, JSON-LD breadcrumb, canonical URL, title
- Serve the assembled HTML

**The chapter API (`/api/chapter/:book/:chapter`):**
- Load cached renders from `renders/{bookIndex}.json`
- For any missing verses, call Grok with a JSON schema response format
- Respond only after all verses are rendered
- Cache to disk; pre-compute ETag for fully-rendered chapters

This is clean and effective. There is no framework complexity, no component model, no hydration cost. The client gets a single HTML file, one CSS blob (inlined), and one fingerprinted JS file. Total bundle: ~16KB minified CSS+JS inlined.

---

## 2. The Symmetry Engine

**Verdict: Fully implemented, genuinely special.**

`style.css:3-146` contains a `:root` block that is itself a design document. Every design token derives from a single 3px base multiplied by Fibonacci numbers:

```css
--base: 3px;
--space-hair:  calc(1  * var(--base));   /*   3px — Fib 1  */
--space-atom:  calc(2  * var(--base));   /*   6px — Fib 2  */
--space-cell:  calc(3  * var(--base));   /*   9px — Fib 3  */
--space-organ: calc(5  * var(--base));   /*  15px — Fib 5  */
--space-limb:  calc(8  * var(--base));   /*  24px — Fib 8  */
--space-body:  calc(13 * var(--base));   /*  39px — Fib 13 */
--space-field: calc(21 * var(--base));   /*  63px — Fib 21 */
--space-world: calc(34 * var(--base));   /* 102px — Fib 34 */
```

Timing follows the same pattern (Fibonacci × 50ms), opacity follows Fib(n)/34, and the comment block cites Weber-Fechner Law, Gestalt proximity, Fitts's Law, Card-Moran-Newell, and Miller's Law to justify each choice. Whether you accept the cited research as binding or not, the *effect* is a spacing and timing system that feels perceptually consistent in a way that ad-hoc values don't.

The JavaScript side (`app.js:7-36`) reads every CSS token at startup via `getComputedStyle`, freezes them into a `SYM` object, and uses only that object for all animation parameters:

```javascript
const SYM = (() => {
  const s = getComputedStyle(document.documentElement);
  const f = n => parseFloat(s.getPropertyValue(n).trim());
  return Object.freeze({ durInstant: f('--dur-instant'), ... });
})();
```

**This means the CSS is the single source of truth for all design decisions, including animation physics.** If you change `--dur-settle` in CSS, the JS transitions update automatically with no code change. That's a real architectural win that most design systems don't achieve.

The consistency is maintained: spot-checking the actual values used against the token names shows no deviations. The desktop gate mockup phone uses `calc(89 * var(--base))` (Fib 89, 267px wide) with a height that achieves a 2:1 ratio. The notch width is `calc(2 * var(--space-body))` — 78px, about 29% of the phone width, close to φ.

One gap: the `--depth-shadow-blur: 13` comment says "Fibonacci" but the shadow values, rubber-band factor, and swipe physics constants are noted as "tuned by feel, not derived" — which is honest. Not every number needs to come from a mathematical principle; the note that these are empirical keeps the rest of the system's claims credible.

---

## 3. The Annotation System

**How annotations are stored:**

Each verse produces a `{ rendering, note }` pair from Grok. These are persisted to `renders/{bookIndex}.json` (0.json = Genesis through 65.json = Revelation) as a flat key-value map:

```json
{
  "0:0": { "rendering": "In the beginning...", "note": "The Hebrew...", "v": "ff54612cf1f0", "t": 1774859214423 },
  "0:1": { ... }
}
```

Keys are `{chapterIndex}:{verseIndex}` (both 0-based). The `v` field is a 12-char SHA256 prefix of `RENDER_MODEL + '\n' + SYSTEM_PROMPT`. This is the **cache invalidation mechanism**: when either the model name or system prompt changes, `RENDER_VERSION` changes, and every entry with an old `v` value is treated as missing and re-rendered on next request.

**The `renders/` directory is committed to git** — explicitly called out in `agents.md` as intentional ("each render costs an API call"). This means the repo grows over time as content is generated, but also means renders survive deploys and are pre-warmed on Railway.

**What's excellent about this design:**
- Version-based invalidation is self-documenting. `git log renders/0.json` tells you when Genesis was last re-rendered and why (if the commit message is good).
- The `v` field ties every render to a specific model+prompt combination. If you roll back the system prompt, stale renders from the old prompt are automatically replaced.
- Concurrent verse rendering (`RENDER_CONCURRENCY = 8`) with `Promise.allSettled` means partial failures don't block the whole chapter — individual verse failures are logged and the chapter renders with whatever succeeded.

**Structural concern — blocking first render on cold chapters:**

```javascript
app.get('/api/chapter/:book/:chapter', async (req, res) => {
  // ...
  if (missing.length > 0) {
    for (let i = 0; i < missing.length; i += RENDER_CONCURRENCY) {
      await Promise.allSettled(batch.map(v => renderVerse(...)));
    }
  }
  res.type('json').send(body); // ← held until all verses render
});
```

The response is held open until **all missing verses are rendered**. For a cold Psalm chapter or Job chapter (some have 50+ verses), the first visitor waits for `ceil(verseCount / 8)` round trips to `api.x.ai`, each with a 30-second timeout. That could be a long wait. Psalms 119 has 176 verses — that's 22 serial batches of 8.

Mitigation options: stream partial results (SSE or chunked JSON), accept an incomplete response and fill gaps on the next request, or pre-render eagerly in a background job. The cleanest given the current architecture would be to render whatever is cached immediately, then queue a background render job for the missing verses and serve an empty placeholder for uncached ones — returning a `complete: false` flag the client can use to retry.

**The note quality constraint:**

```javascript
if (parsed.note.length >= parsed.rendering.length) {
  log.warn('note_too_long', { book, chapter, verse, ... });
}
```

This is a quality gate but not an enforcement gate. The report shows 74 `note_too_long` warnings for Ecclesiastes on March 31, with notes up to 190 chars into an 86-char render slot. The system logs the violation but still serves the overlong note. Given the prompt's explicit `CRITICAL LENGTH RULE`, this suggests a model compliance issue with Ecclesiastes content specifically, possibly because Ecclesiastes quotes are short and the model has more to say about them.

---

## 4. The Navigation System

**Book/chapter navigator (tapping the header):**

Tapping `#header` triggers a fullscreen overlay (`#nav`) that:
1. Rebuilds the book list fresh on every open (no stale state)
2. Auto-expands the current book using `.expanded` class
3. Uses CSS `grid-template-rows: 0fr → 1fr` transitions for the chapter grids — this is the correct modern approach, not the `max-height: 10000px` antipattern
4. Listens for `transitionend` via the `onTransition()` helper to scroll the newly-expanded book into view
5. On chapter pill tap: fades `#reading` out, calls `fillAllPanels()`, fades in

```javascript
name.addEventListener('click', e => {
  // collapse other expanded book, toggle this one
  item.classList.toggle('expanded', !wasExpanded);
  if (!wasExpanded) {
    onTransition(wrap, 'grid-template-rows', SYM.durSettle * 1000 + SYM.safetyPad, () => {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
});
```

The `onTransition()` helper (`app.js:60-72`) is a small gem — it fires a callback on `transitionend` filtered to a specific CSS property, with a safety-timeout fallback to ensure it always fires even if the transition is interrupted. This pattern solves a real gotcha with transition event handlers.

**History API integration is correct:** The header click pushes `{ nav: true, pos }`, and `popstate` closes the nav overlay if `navOpen` is true, enabling native back-button behavior to dismiss the navigator.

**The 3-panel DOM rotation:**

The three `.ch-panel` elements stay in the DOM permanently. On swipe completion:
```javascript
if (dir === 1) {
  track.appendChild(panels[0]); // move left panel to end
  panels.push(panels.shift());  // rotate the JS array
} else {
  track.insertBefore(panels[2], panels[0]);
  panels.unshift(panels.pop());
}
```

No DOM creation/destruction. Just repositioning. Then `fillPanel()` loads new content into the now-offscreen recycled panel. This is the right architecture for infinite scrolling — it's how iOS UITableView cell reuse works.

---

## 5. The Desktop Gate

**Implementation: CSS media query, not user-agent sniffing.**

```css
@media (min-width: 480px) {
  #mobile-content { display: none; }
  #desktop-gate { display: flex; }
}
```

The gate shows a phone mockup (proportioned with Fibonacci values) and the text "VAPOURWARE.AI / IS DESIGNED FOR MOBILE". On mobile, `#desktop-gate { display: none }` and `#mobile-content { display: flex }`.

**This is the right choice.** UA sniffing breaks on tablets, foldables, and non-standard agents. The viewport width is the actual constraint (the 3-panel swipe UX doesn't make sense on wide screens), and 480px is a reasonable breakpoint for "this is a phone-sized viewport."

The phone mockup itself is fully Fibonacci-derived: 267px wide (Fib 89 × 3px), 534px tall (2:1 ratio), 24px border-radius (Fib 8), 78px notch width (2 × Fib 13). Even the desktop gate is on-system.

---

## 6. The "simplify" Function/Pattern

**There is no function named `simplify` in the application code.** The reference is to the `/simplify` Claude Code skill — a meta-tool in the Claude Code environment that reviews recently-changed code for reuse, quality, and efficiency.

In the **application code**, the closest explicit text-cleaning function is `cleanText()` in `server.js:90-92`:

```javascript
function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replaceAll('vapor', 'vapour');
}
```

This enforces two invariants described in `agents.md`:
- **No em-dashes**: Grok sometimes produces em-dashes (U+2014) in renderings. This replaces them with `', '` (comma-space). The system prompt also forbids them, so this is a belt-and-suspenders defense.
- **British spelling**: `'vapor'` → `'vapour'` to match the project name.

**Bug in `cleanText`:** `replaceAll('vapor', 'vapour')` is a substring replacement with no word-boundary guard. If Grok generates a rendering containing "evaporates" or "evaporation", it becomes "evapourrates" or "evapourration". The fix is `replace(/\bvapor\b/g, 'vapour')`. This is unlikely to occur in Bible renderings but it's a landmine.

More broadly, the "simplify" philosophy is the architecture itself: the entire product is ~1,600 lines of source across 6 files, no client-side framework, no build toolchain, one dependency (`express`+`compression`+`terser`+`posthog-node`). Every component can be read in a single sitting. This is a deliberate constraint, documented as an invariant in `agents.md`: "Vanilla JS only. No frameworks, no new npm dependencies without strong justification."

---

## 7. Performance

**Bundle sizes (per the March 31 report):**

| Asset | Raw | Minified |
|---|---|---|
| `app.js` | 23,852 bytes | 15,659 bytes |
| `style.css` | ~7KB | inlined |
| Total transferred | — | ~23KB |

At p50 load time of 19ms and p90 of 71ms, this is already excellent. The performance architecture has several smart decisions:

**Startup: CSS inlining + JS fingerprinting**
```javascript
// server.js startup
const CSS_SRC = fs.readFileSync('public/style.css', 'utf8');
// injected into HTML: <link rel="stylesheet" href="/style.css"> → <style>...</style>
```
No separate CSS request. No FOUC. The HTML, CSS, and a preload hint for JS all arrive in one response.

```javascript
// JS served as /app.{hash}.js with Cache-Control: immutable
res.setHeader('Cache-Control', CACHE_IMMUTABLE);
```
After first load, the JS is cached forever (until the hash changes from a code change). This is a CDN-friendly pattern without needing a CDN.

**Per-page: chapter data preloading**
When a chapter URL is visited server-side and the chapter is fully cached, the JSON is inlined into the HTML:
```html
<script id="preloaded" type="application/json">{"book":"Genesis","ch":1,"verses":[...]}</script>
```
The client reads this at startup and seeds `chapterCache` before any fetch. First contentful paint shows text with zero API calls.

**Adjacent prefetching:**
```javascript
(window.requestIdleCallback || ...)(() => {
  prefetchAdjacent(pos, 1);
  prefetchAdjacent(pos, -1);
});
```
Two chapters ahead/behind are prefetched on idle after initial load. Combined with the 3-panel swipe system, chapter transitions feel instant.

**Request deduplication:**
```javascript
if (inflightFetches.has(key)) return inflightFetches.get(key);
```
If the same chapter is fetched twice concurrently (e.g., from prefetch + direct load), the second call joins the first promise. No duplicate requests.

**ETag 304 responses for fully-rendered chapters:**
Server computes SHA256 of the chapter JSON body and caches the ETag. If `If-None-Match` matches, returns 304 with no body. For chapters that don't change (content is cached on disk), returning clients get 304s.

---

## 8. PostHog Integration

**Current state: working and reasonably thorough.**

**Client-side** (`app.js:39-47` and throughout):
```javascript
function ev(type, data) {
  try { posthog.capture(type, data); } catch {}
}
```
The `try/catch` wrapper means PostHog failures never crash the app. Events tracked:
- `view` — every chapter load with `{ book, ch }`
- `nav` — navigation with `{ method: 'swipe' | 'tap' }`
- `perf` — page load performance with `{ loadMs, ttiMs }` (via `PerformanceNavigationTiming`)
- `session` — depth on page hide with `{ depth: viewCount }`
- `client_error` — all JS errors and unhandled rejections via `reportError()`

The PostHog snippet in `index.html:120-128` is the standard async loader with `capture_pageview: false` (smart — `view` events are fired manually, giving chapter-level granularity rather than URL-level), `autocapture: false` (appropriate for a minimal UI with no standard form/button targets), and `capture_pageleave: true`.

**Server-side** (`logger.js`):
```javascript
function makeLog(level) {
  return (event, data = {}) => {
    posthog.capture({ distinctId: 'server', event: `server_${event}`, properties: { level, ...data } });
  };
}
```
All server events go to PostHog as `server_*` events with `distinctId: 'server'`. This means server events and client events are both in PostHog and can be correlated.

**Documentation drift — `agents.md` is stale on logging:**

`agents.md` describes `logger.js` as "Structured JSONL server logging with daily rotation, 7-day retention" and lists an `analytics.js` file. The actual `logger.js` uses PostHog, and `analytics.js` doesn't exist. The JSONL files in `logs/` are from the previous logger (before it was replaced with PostHog, apparently on or around April 1). This needs updating.

**What PostHog data would improve the product:**

The `note_too_long` warning is currently logged but not surfaced in a way that's actionable. Adding a PostHog insight for "percentage of `note_too_long` events by book" would make this a dashboard item rather than a grep.

Missing events worth adding:
- `verse_expanded` — which verses are users tapping to read notes (core engagement signal)
- `chapter_scrolled` — did the user read the full chapter or just the top?
- `render_latency` — how long did cold-render chapter requests take? (correlate with retention)

---

## 9. Issues Requiring Attention

### P1 — Rate limiter may be a no-op behind Railway's proxy

`server.js:279-285`:
```javascript
function rateLimit(req, res) {
  if (!checkApiRate(req.ip)) {
    res.status(429).json({ error: 'too many requests' });
    return false;
  }
  return true;
}
```

`req.ip` in Express is `::1` or `127.0.0.1` when behind a reverse proxy unless `app.set('trust proxy', 1)` is configured. Railway's infrastructure sits in front of the Express server, so every request may appear to come from `127.0.0.1`, making the rate limiter useless — all 30 requests/minute would be counted against the same "IP." The fix is one line: `app.set('trust proxy', 1);` before the routes.

Verify by temporarily logging `req.ip` and `req.headers['x-forwarded-for']` in production. If they're always `::1`, the rate limiter isn't working.

### P1 — `cleanText` replaces 'vapor' as a substring

```javascript
function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replaceAll('vapor', 'vapour');
}
```

`'evaporation'.replace('vapor', 'vapour')` → `'evapourration'`. The fix:

```javascript
return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/g, 'vapour');
```

Low probability in Bible renderings but a real correctness issue.

### P1 — `agents.md` documentation drift

The file map in `agents.md` references `logger.js` as JSONL-based with daily rotation and `analytics.js` as a separate analytics file. Both descriptions are wrong — `logger.js` now uses PostHog, and `analytics.js` doesn't exist. An agent following `agents.md` will look for log files that no longer represent live data and may incorrectly describe the logging architecture.

### P2 — Blocking first-render on cold chapters

First visitor to an unrendered chapter waits for all verses to render synchronously before getting a response. For Psalms 119 (176 verses), that's 22 serial batches × Grok latency. Consider one of:
1. Respond immediately with whatever is cached, serve placeholders for missing verses, let the client retry
2. Background-render missing verses after responding with partial data
3. Pre-render eagerly on deploy for the most commonly visited chapters

### P2 — `note_too_long` missing structured fields (open from March 31 report)

`server.js:270`:
```javascript
log.warn('note_too_long', { book, chapter, verse, noteLen: parsed.note.length, renderLen: parsed.rendering.length });
```

The report confirms these fields are arriving as null in PostHog events. This is likely because the `renderVerseOnce` function receives `(book, chapter, verse)` — verify the argument names match the log call exactly. If `chapter` is the chapter number (1-based integer) and `verse` is also a 1-based integer, they should serialize correctly. Might be a caller passing the wrong type.

### P2 — `scrollPositions` LRU is actually FIFO

```javascript
if (scrollPositions.size > SCROLL_LRU_MAX) scrollPositions.delete(scrollPositions.keys().next().value);
```

This deletes the *first inserted* key, not the *least recently used*. For a reading app where users go back and forth, they may repeatedly evict chapters they just visited. A proper LRU would either use a `Map` with delete-and-reinsert on access, or just keep the 50 limit (it's small enough that FIFO vs. LRU hardly matters in practice). Worth noting as a misleading comment if anyone reads it.

### P3 — `POSTHOG_KEY` as hardcoded fallback in `logger.js`

```javascript
const POSTHOG_KEY = process.env.POSTHOG_API_KEY || 'phc_DeGd...';
```

A PostHog project API key is designed to be public (it goes in the browser bundle), so this isn't a secret exposure. But a hardcoded key in the environment fallback means the key can't be rotated without a code change. Consider removing the fallback and failing fast if `POSTHOG_API_KEY` is missing, the same way the server does for `XAI_API_KEY`.

---

## 10. What's Excellent

**The `onTransition()` helper** (`app.js:60-72`) is a clean solution to a real problem. `transitionend` events are notoriously unreliable (they fire per-property, they don't fire if the element is removed, they don't fire if the transition is interrupted). The safety timeout ensures the callback always runs:

```javascript
function onTransition(el, prop, timeoutMs, fn) {
  function handler(e) {
    if (e && prop && e.propertyName !== prop) return;
    el.removeEventListener('transitionend', handler);
    clearTimeout(safety);
    fn();
  }
  el.addEventListener('transitionend', handler);
  const safety = setTimeout(() => {
    el.removeEventListener('transitionend', handler);
    fn();
  }, timeoutMs);
}
```

**`RENDER_VERSION` cache invalidation** is elegant. `crypto.createHash('sha256').update(RENDER_MODEL + '\n' + SYSTEM_PROMPT).digest('hex').slice(0, 12)` ties every cached render to a specific model+prompt. Change the system prompt, all renders automatically invalidate without needing a migration or cache flush. The downside (all renders invalidate) is the upside (you never serve stale content from an old model).

**The `stale()` guard in `fillPanel()`** (`app.js:311`):
```javascript
const stale = () => !scroll.isConnected || scroll.dataset.p !== String(p);
```
Async fetch operations can complete after the panel has been recycled for different content. Every async checkpoint tests `stale()` and aborts if the element has moved on. This prevents rendering content from a previous swipe into the wrong panel.

**The system prompt is the product.** The theological framework — seven lenses, core values, rendering and note guidelines — is what differentiates vapourware from a plain Bible app. The `note-guidelines` section's "margin scribble not commentary, one punchy observation, vary the angle" constraint produces a distinct voice. The `rendering-guidelines` prohibition on em-dashes and mandate for "vivid, concrete language" are specific enough to actually constrain the model's output. This prompt has been iterated.

**Security headers** are comprehensive: CSP with `default-src 'self'`, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, and HSTS in production. The CSP explicitly allows PostHog's asset CDN and ingestion endpoints, which is the right level of specificity (not `*`).

**The HTML is a love letter.** The source comment contains an ASCII art cross, Ecclesiastes 1:2 in full, a poem about `hevel`, and an ASCII art rendering of "ITS ALL JESUS". A first-principles choice to hide the theological statement in the page source — exactly the kind of intentional detail that makes a piece of software feel like a piece of art.

**The preloaded data pattern** eliminates the round-trip for cached chapters without needing server-side rendering or hydration. The server inlines `<script id="preloaded" type="application/json">` and the client reads it at startup. Zero latency for warm chapters, graceful degradation (fetch) for cold ones.

**`requestIdleCallback` with fallback** (`app.js:643-644`):
```javascript
(window.requestIdleCallback || (cb => setTimeout(cb, SYM.durBreath * 1000)))(() => { ... });
```
The fallback uses `SYM.durBreath * 1000` (250ms, Fibonacci timing) rather than a magic number. Even the fallback timer is on-system.

---

## 11. Next Engineering Priorities

**P1 — Fix rate limiter trust proxy (one line)**
```javascript
app.set('trust proxy', 1); // add before routes
```

**P1 — Fix `cleanText` word-boundary bug**
```javascript
return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/g, 'vapour');
```

**P1 — Update `agents.md` logging description**
Replace the JSONL/analytics.js description with PostHog. Remove `analytics.js` from the file map. This is the document agents use to understand the project.

**P2 — Add `ch` + `vs` to `note_too_long` log events**
Per the March 31 report action item 2 — one-line fix. Makes the warning actionable.

**P2 — Address `note_too_long` at content generation level**
Per the March 31 report action item 1 — 74 warnings in Ecclesiastes. Options:
- Add a hard char-count constraint to the note guideline in the system prompt (~80 chars)
- Add runtime truncation with ellipsis in `renderVerseOnce`
- Note: changing the system prompt changes `RENDER_VERSION` and invalidates all 20 rendered books of cached renders. Weigh that cost.

**P2 — Partial render response for cold chapters**
Return whatever is cached immediately with a `complete: false` flag, let the client retry for the missing verses. Prevents 30-second+ waits for dense chapters.

**P3 — Add `verse_expanded` event**
The most important engagement signal is whether users are reading notes. Currently there's no telemetry on verse taps. One line in `renderVersesInto()`:
```javascript
wrap.addEventListener('click', () => {
  if (sliding || touch.horiz) return;
  wrap.classList.toggle('expanded');
  if (wrap.classList.contains('expanded')) {
    ev('verse_expanded', { book: BOOKS[ALL[pos].bi], ch: ALL[pos].ch + 1 });
  }
});
```

**P3 — Remove hardcoded PostHog key fallback from `logger.js`**
Fail fast if `POSTHOG_API_KEY` is missing, same as `XAI_API_KEY`. Enables key rotation without code changes.

---

## Totals

| Metric | Value |
|---|---|
| Total source lines | 1,634 |
| Client JS (raw) | 23,852 bytes |
| Client JS (minified) | 15,659 bytes |
| CSS (raw) | ~7,000 bytes |
| p50 load | 19ms |
| p90 load | 71ms |
| npm dependencies | 4 (express, compression, terser, posthog-node) |
| Client-side frameworks | 0 |

This is one of the most carefully engineered small codebases I've reviewed. The constraints are unusually well-enforced — the Fibonacci system is consistent, the invariants documented in `agents.md` are actually maintained in the code, and the complexity that exists (swipe physics, panel rotation, cache invalidation) is domain complexity rather than accidental complexity. The main failure mode is documentation drift; the code is ahead of the docs at the moment.
