# vapourware.ai

Current version: **v0.0.1**

Guide for AI agents working on vapourware.ai — a mobile-only Bible reader that renders every verse in modern English with margin notes via Grok. The name plays on *hevel* (vapour) from Ecclesiastes 1:2. The project is intentionally small, frameworkless, and deeply opinionated about its theological voice. Read `README.md` first for configuration and operations.

## Architecture

`server.js` wires four layers together; each lives in its own directory and depends only on the ones above it.

1. **Foundations** (`src/config.js`, `src/canon.js`, `src/text.js`, `src/log.js`) — environment parsing, the canon (books, chapters, verse refs, slugs), house-style text cleanup and escaping, structured logging. Chapters and verses are 1-based everywhere except the store's file keys.
2. **Rendering** (`src/render/`)
   - `store.js` — the render cache: `RENDERS_DIR/<render version>/<book>.json`, keyed `"chapterIndex:verseIndex"` (0-based), every entry stamped with its version. A config change starts a fresh directory and never deletes another version's. At startup it removes the pre-4.7 flat layout (`RENDERS_DIR/<book>.json`), clears temp files, and seeds from the committed `renders/<version>/`, which the server only reads. Reads are served from memory; writes land in memory at once and persist with tmp+rename, coalesced per book.
   - `scheduler.js` — the one pool all upstream calls go through. Units are deduped by key; foreground beats background (background waits while any foreground unit is unfinished, including retry backoff); within a class the most recently requested units go first; within a request, submission order. Retries with backoff unless an error is marked `retryable: false`.
   - `renderer.js` — turns a chapter request into units via the pipeline, submits them, writes each finished unit to the store, and logs `chapter_render_started` / `chapter_render_finished` with timing summaries and billed token totals (`inputTokens`, `cachedTokens`, `outputTokens`, `reasoningTokens`).
   - `passage-v1.js` (production), `verse-v1.js`, `section-v2.js` — the pipelines, chosen by `pipelines.js`. A pipeline is `{ name, version, info, unit, plan(chapterRef, missingVerses) }`, where `plan` returns units `{ key, refs, logFields, render(usage) }`. passage-v1 splits a chapter into near-even passages of at most 10 verses, renders a whole passage per call, and stores only the verses that were missing.
3. **HTTP** (`src/http/`) — the Express app (`app.js`), JSON API (`api.js`), pages and SEO (`pages.js`), the page shell build (`shell.js`), and beacon endpoints (`telemetry.js`).
4. **Client** (`client/`) — `index.html` template, `style.css`, and `app.js`, compiled into the page shell at startup. Nothing in `client/` is served raw; `public/` is served as-is.

The client (`client/app.js`, one IIFE) is organised as: telemetry, canon (every chapter has a flat index `p`), motion constants, a chapter store (fetch dedupe, polling with backoff and caps, watchers), `Panel` (one chapter per track panel; builds the verse list once and swaps skeleton lines for verses as they arrive), and the reader (pager, swipe gestures, navigator, history). Desktop-width visitors see the CSS "designed for mobile" gate and the reader never starts, so no chapters are fetched or rendered for them.

## The prompts

- `prompts/passage-v1.md` — the production prompt, deliberately short: who is reading and how, what to write for each verse, and the app's one opinion (the Bible as one story that leads to Jesus). Length, angle, style, and when to mention Jesus are the model's call. Keep it that way: describe the situation rather than adding rules, and put anything the app needs regardless into code (`cleanText`) instead. A test keeps it short and free of MUST/NEVER-style rules.
- `prompts/verse-v1.md` — the earlier rule-based prompt: seven theological lenses, rendering guidelines, and note guidelines (notes shorter than the verse, one sentence, one angle, Jesus only on direct connections, don't moralize).
- `prompts/margin-note-v3.md` — the section-v2 prompt: every verse gets a 12-26 word note from a Christian reader with good taste; worthy Christ-shaped patterns allowed, forced allegory not.

Every prompt file is part of its pipeline's render version (after trimming surrounding whitespace). Editing one starts that pipeline's cache from scratch. That is sometimes the point, but know the cost first.

## Invariants

These are load-bearing. Don't break them:

- **Render versions are pinned** — `test/render-version.test.js` pins the cache-key hashes. A change that moves one points production at a fresh, empty directory and re-renders, and re-bills, the whole Bible as people read it. Only update a pin deliberately, and say so in the PR. Every pipeline hashes model, reasoning effort, system prompt, and response schema; `passage-v1` adds its passage size, and `section-v2` its fixed task/constraints text and the section map's version and fingerprint.
- **Never serve another version, never delete one automatically** — entries are only served when their stamp matches the running version, and other versions' directories are left for an operator to remove. The committed `renders/` holds only a current version (a test enforces it).
- **No em dashes, and "vapour" not "vapor"** — `cleanText()` in `src/text.js` enforces both on every model string (keeping case: "Vapor" becomes "Vapour"), so prompts don't need to ask.
- **Rendered text never changes under a reader** — passage-v1 renders a whole passage for context but stores only the verses that were missing.
- **verse-v1 notes shorter than renderings** — asked of the model and logged as `note_too_long` when missed. Not a rule for the other pipelines.
- **v2 is eval-first** — `section-v2` stays opt-in until smoke, edge, prod-sim, and gate reports are reviewed. Eval scenario metadata must never reach the model payload.
- **v2 section coverage is total** — `data/sections.json` covers all 31,071 verses exactly once (validated whenever the map loads). Units are keyed by section id, so a section shared by two chapters renders once.
- **Rendering follows demand** — never pre-render the Bible. Failed units leave their verses missing and retryable by the next request.
- **Mobile-only** — wider than 480px shows a message instead of the reader. Intentional, not a TODO.
- **Page shell** — CSS is inlined and JS is served under a content hash with immutable caching. Don't add `<link rel="stylesheet">` or unhashed script tags.
- **Escaping** — template placeholders are `{{escaped}}` by default; `{{{raw}}}` is only for values built with `jsonForScript()` or trusted static assets. Model text is never trusted.
- **Dark/light via `prefers-color-scheme`** — automatic, no toggle. Check both themes.
- **Fibonacci Symmetry Engine (`--base: 3px`)** — spacing is `Fib(n) × 3px` (3, 6, 9, 15, 24, 39, 63, 102px) and timing `Fib(n) × 50ms`. Use the tokens in `client/style.css :root`; gesture physics constants live in `client/app.js`.
- **Security headers** — CSP (`default-src 'self'`, no inline script), `X-Frame-Options: DENY`, HSTS in production. Don't weaken them.
- **Rate limiting** — 30/min per IP on `/api/log`, 60/min on `/api/ev`. The chapter API is deliberately not rate-limited; the scheduler's concurrency cap protects the upstream instead.
- **URLs** — `/{book-slug}/{chapter}`, slugs lowercased with spaces as hyphens (`1-kings`, `song-of-solomon`). The `lastPos` cookie (`bookIndex:chapterIndex`, 0-based) sends `/` back to where the reader left off.

## Patterns to follow

- **No frameworks.** No new npm dependencies without strong justification.
- **Dependencies are passed in** — modules take `log`, `store`, `fetchImpl`, and so on as arguments rather than reaching for globals, so tests can use `memoryLogger()` and fakes.
- **Structured logging** — `log.info|warn|error|debug(event, data)` with a snake_case event name.
- **CSS custom properties** for theming, with light values in `:root` and dark values under `@media (prefers-color-scheme: dark)`.

## Testing changes

1. `npm run check` and `npm test` (unit suites plus end-to-end tests that spawn `server.js` against a mock xAI; no network needed).
2. For client changes, run the server against a mock or real key and check in a phone-sized window, both themes: cold chapter (skeleton, then verses appearing a passage at a time), tap a verse while the chapter is still rendering (the note stays open), swipe both ways and at both ends of the Bible, open the navigator and pick a chapter, then Back.
3. Optional: `npm run sections:generate` (needs network access to OpenBible).
4. Optional v2 evals with Railway's variables, never by flipping production: `railway run --service ye --environment production -- npm run eval:v2` (and `:edge`, `:prod-sim`, `:gate`). Prefer `EVAL_REPORTS_DIR=/tmp/...` for exploratory runs; attach reviewed reports to the PR.

When v2 is approved, flip it with `RENDER_PIPELINE=section-v2` (its renders get their own version directory); roll back by unsetting it.

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
