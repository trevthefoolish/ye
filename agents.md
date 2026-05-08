# vapourware.ai

Current version: **v0.0.1**

Guide for AI agents working on vapourware.ai — a mobile-first Bible reader that renders every verse in modern English with scholarly margin notes via Grok. The name plays on *hevel* (vapour) from Ecclesiastes 1:2. The project is intentionally small, frameworkless, and deeply opinionated about its theological voice.

## Architecture

Express serves a single-page app. The server does most of the heavy lifting:

1. **Rendering pipeline** — The default production path is the original one-verse Grok Chat Completions renderer. A guarded experimental path, `RENDER_PIPELINE=section-v2`, renders reference-only verse sections through xAI Responses API using `rendererV2.js`.
2. **Caching** — Renders are stored to disk as `renders/{bookIndex}.json` locally, or `RENDERS_DIR/{bookIndex}.json` in production (Railway uses `/data/renders`). An in-memory `Map` sits on top for fast reads. Pre-computed ETags enable 304 responses for fully-rendered chapters.
3. **Version stamping** — The default v1 `RENDER_VERSION` remains a SHA of the model name + inline system prompt. The v2 hash additionally includes model, reasoning effort, prompt version/content, schema version, and section-map version. Do not enable v2 in production casually.
4. **HTML assembly** — At startup, CSS is inlined into the HTML template and JS is minified and fingerprinted. Per-request, the catch-all route injects OG tags, JSON-LD, canonical URLs, and preloaded chapter data.

The client (`public/app.js`, ~600 lines vanilla JS) maintains a **three-panel swipe system** — previous, current, and next chapters are always in the DOM for instant gesture response. It handles:
- Touch/swipe navigation with spring physics and GPU-composited depth effects
- Book/chapter navigator overlay with animated grid
- Verse tap-to-expand for margin notes
- Scroll position persistence (LRU, max 50 entries)
- History API integration for back/forward
- Prefetching adjacent chapters via `requestIdleCallback`

## The prompts

The production v1 prompt is still located in `server.js` (the `SYSTEM_PROMPT` constant). It defines:

- **Seven theological lenses** — Messianic, Communal, Human and Divine, Ancient, Unified, Wisdom, Meditation. These are intentional constraints, not suggestions.
- **Rendering guidelines** — translate with care, vivid concrete language, honor ancient literary context, preserve wordplay and intertextual echoes.
- **Note guidelines** — notes must be shorter than the rendering. One sentence. "Margin scribble" not "commentary." Vary the angle. Don't moralize.
- **Core values** — wonder over certainty, humility before the text, depth without jargon, faithfulness over novelty.

Renderer v2 uses `prompts/margin-note-v2.md`: every verse gets a note, notes should feel like a Christian reader with good taste penciling sharp observations in the margin, and worthy Christ-shaped patterns are allowed without forcing allegory.

Changing the active prompt, model, reasoning effort, schema version, or section-map version changes `RENDER_VERSION`, which invalidates active-pipeline cached renders. This is by design, but understand the cost before editing.

## Invariants

These are load-bearing constraints. Don't break them:

- **No em-dashes** — `cleanText()` strips them, replacing with commas. The system prompt forbids them too.
- **"vapour" not "vapor"** — `cleanText()` enforces British spelling. This is the project name.
- **v1 notes shorter than renderings** — still part of the production v1 prompt, logged as a warning if violated. This is not a v2 invariant.
- **v2 is eval-first** — `section-v2` must remain opt-in until smoke eval output is reviewed.
- **Mobile-only** — desktop (>480px) shows a blocking message. This is intentional, not a TODO.
- **CSS inlined at startup** — `style.css` is read from disk and injected into the HTML template. Don't add a `<link>` tag.
- **JS fingerprinted** — content hash in the filename, served with immutable cache headers.
- **Dark/light via `prefers-color-scheme`** — automatic, no manual toggle. Always respect both themes.
- **Fibonacci Symmetry Engine (`--base: 3px`)** — all spacing is `Fib(n) × 3px` (3, 6, 9, 15, 24, 39, 63, 102px). Timing is `Fib(n) × 50ms`. Opacity is `Fib(n)/34`. Ratios converge on φ ≈ 1.618. See the perceptual basis comment block in `style.css :root`.
- **HTML escaping** — `escapeHtml()` on all dynamic content injected into HTML. No exceptions.
- **Security headers** — CSP (`default-src 'self'`), X-Frame-Options DENY, HSTS in production. Don't weaken.
- **Rate limiting** — 30 requests/min per IP on the chapter API, 60 events/min on analytics.

## File map

| File | Purpose |
|---|---|
| `server.js` | Express server, system prompt, rendering pipeline, caching, SEO, security |
| `rendererV2.js` | Experimental section renderer, xAI Responses request shape, schema, section grouping |
| `public/app.js` | Client SPA — swipe nav, navigator, verse expansion, prefetching, analytics |
| `public/style.css` | All styling — theming, dark/light, animations, Fibonacci Symmetry Engine |
| `public/index.html` | HTML template with config/preload placeholders and ASCII art cross |
| `data/bible.json` | 66 books with chapter counts and per-chapter verse counts |
| `data/sections.json` | Explicit section map for renderer v2 smoke eval and grouping |
| `prompts/margin-note-v2.md` | Greenfield margin-note prompt for renderer v2 |
| `renders/` | Baseline cached renders per book (JSON, keyed by `chapterIndex:verseIndex`). Intentionally committed — each render costs an API call |
| `logger.js` | Structured JSONL server logging and anonymous event logging |
| `railway.json` | Railway deployment config — health check, restart policy |

## Patterns to follow

- **Vanilla JS only.** No frameworks, no new npm dependencies without strong justification.
- **CSS custom properties** for theming. Both light and dark values defined in `:root` and `@media (prefers-color-scheme: dark)`.
- **Structured logging** — use `log.info()`, `log.warn()`, `log.error()` from `logger.js`. First arg is a snake_case event name, second is a data object.
- **Express static** serves `public/` but `index.html` is excluded (`index: false`) because the catch-all route handles it with injected metadata.
- **URL slugs** — book names lowercased with spaces replaced by hyphens (e.g., `1-kings`, `song-of-solomon`).

## Testing changes

1. `npm test`
2. `npm run check`
3. Optional renderer v2 smoke eval: `XAI_API_KEY=your-key npm run eval:v2`
4. `XAI_API_KEY=your-key NODE_ENV=production node server.js`
5. Open in a browser window < 480px wide (or mobile device)
6. Verify dark and light themes both work (toggle your OS setting)
7. Swipe between chapters — previous and next should load instantly
8. Tap a verse to expand its note
9. Check the server console for structured log output and any warnings

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
