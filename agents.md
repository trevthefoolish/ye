# vapourware.ai

Current version: **v0.0.1**

Guide for AI agents working on vapourware.ai — a mobile-first Bible reader that renders every verse in modern English with scholarly margin notes via Grok. The name plays on *hevel* (vapour) from Ecclesiastes 1:2. The project is intentionally small, frameworkless, and deeply opinionated about its theological voice.

## Architecture

Express serves a single-page app. The server does most of the heavy lifting:

1. **Rendering pipeline** — Grok renders each verse on-demand via JSON schema (`renderVerse` in `server.js`). Each verse produces a `{ rendering, note }` pair. Up to 8 verses render concurrently per request.
2. **Caching** — Renders are stored to disk as `renders/{bookIndex}.json` (e.g., `0.json` is Genesis). An in-memory `Map` sits on top for fast reads. Pre-computed ETags enable 304 responses for fully-rendered chapters.
3. **Version stamping** — `RENDER_VERSION` is a SHA of the model name + system prompt. When either changes, the hash changes, and all cached renders auto-invalidate on next request.
4. **HTML assembly** — At startup, CSS is inlined into the HTML template and JS is minified and fingerprinted. Per-request, the catch-all route injects OG tags, JSON-LD, canonical URLs, and preloaded chapter data.

The client (`public/app.js`, ~600 lines vanilla JS) maintains a **three-panel swipe system** — previous, current, and next chapters are always in the DOM for instant gesture response. It handles:
- Touch/swipe navigation with spring physics and GPU-composited depth effects
- Book/chapter navigator overlay with animated grid
- Verse tap-to-expand for margin notes
- Scroll position persistence (LRU, max 50 entries)
- History API integration for back/forward
- Prefetching adjacent chapters via `requestIdleCallback`

## The system prompt

Located in `server.js` (the `SYSTEM_PROMPT` constant). This is the heart of the product. It defines:

- **Seven theological lenses** — Messianic, Communal, Human and Divine, Ancient, Unified, Wisdom, Meditation. These are intentional constraints, not suggestions.
- **Rendering guidelines** — translate with care, vivid concrete language, honor ancient literary context, preserve wordplay and intertextual echoes.
- **Note guidelines** — notes must be shorter than the rendering. One sentence. "Margin scribble" not "commentary." Vary the angle. Don't moralize.
- **Core values** — wonder over certainty, humility before the text, depth without jargon, faithfulness over novelty.

Changing the system prompt or model changes `RENDER_VERSION`, which invalidates every cached render across all 66 books. This is by design, but understand the cost before editing.

## Invariants

These are load-bearing constraints. Don't break them:

- **No em-dashes** — `cleanText()` strips them, replacing with commas. The system prompt forbids them too.
- **"vapour" not "vapor"** — `cleanText()` enforces British spelling. This is the project name.
- **Notes shorter than renderings** — enforced in the prompt, logged as a warning if violated.
- **Mobile-only** — desktop (>480px) shows a blocking message. This is intentional, not a TODO.
- **CSS inlined at startup** — `style.css` is read from disk and injected into the HTML template. Don't add a `<link>` tag.
- **JS fingerprinted** — content hash in the filename, served with immutable cache headers.
- **Dark/light via `prefers-color-scheme`** — automatic, no manual toggle. Always respect both themes.
- **`--base: 6px` unit system** — all spacing and typography derive from this CSS custom property.
- **HTML escaping** — `escapeHtml()` on all dynamic content injected into HTML. No exceptions.
- **Security headers** — CSP (`default-src 'self'`), X-Frame-Options DENY, HSTS in production. Don't weaken.
- **Rate limiting** — 30 requests/min per IP on the chapter API, 60 events/min on analytics.

## File map

| File | Purpose |
|---|---|
| `server.js` | Express server, system prompt, rendering pipeline, caching, SEO, security |
| `public/app.js` | Client SPA — swipe nav, navigator, verse expansion, prefetching, analytics |
| `public/style.css` | All styling — theming, dark/light, animations, `--base` unit system |
| `public/index.html` | HTML template with config/preload placeholders and ASCII art cross |
| `data/bible.json` | 66 books with chapter counts and per-chapter verse counts |
| `renders/` | Cached renders per book (JSON, keyed by `chapterIndex:verseIndex`). Intentionally committed — each render costs an API call |
| `logger.js` | Structured JSONL server logging with daily rotation, 7-day retention |
| `analytics.js` | Anonymous event logging with daily rotation, 30-day retention |
| `railway.json` | Railway deployment config — health check, restart policy |

## Patterns to follow

- **Vanilla JS only.** No frameworks, no new npm dependencies without strong justification.
- **CSS custom properties** for theming. Both light and dark values defined in `:root` and `@media (prefers-color-scheme: dark)`.
- **Structured logging** — use `log.info()`, `log.warn()`, `log.error()` from `logger.js`. First arg is a snake_case event name, second is a data object.
- **Express static** serves `public/` but `index.html` is excluded (`index: false`) because the catch-all route handles it with injected metadata.
- **URL slugs** — book names lowercased with spaces replaced by hyphens (e.g., `1-kings`, `song-of-solomon`).

## Testing changes

1. `XAI_API_KEY=your-key node server.js`
2. Open in a browser window < 480px wide (or mobile device)
3. Verify dark and light themes both work (toggle your OS setting)
4. Swipe between chapters — previous and next should load instantly
5. Tap a verse to expand its note
6. Check the server console for structured log output and any warnings
