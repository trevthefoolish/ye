# vapourware.ai

**v0.0.1**

*Absolute vapour, says the Teacher, absolute vapour. Everything is vapour.*
— Ecclesiastes 1:2

**vapour** + **ware**. The Hebrew word *hevel* — that morning mist above the garden, the breath God breathed into clay. Everything is vapour, but He is not.

vapourware.ai renders the entire Bible in modern English with illuminating margin notes. Every verse is translated with care for the original Hebrew, Aramaic, and Greek. Every note is a curious scribble in the margin — one surprising thing about the text, not a sermon.

It's designed for deep, repeated reading. The kind that reveals its meaning over a lifetime.

## How it works

Each verse is rendered on-demand by [Grok](https://x.ai) through a theological framework built on seven lenses:

- **Messianic** — every narrative thread contributes to the story that finds fulfillment in Jesus
- **Communal** — the Bible addresses communities and peoples, not just isolated individuals
- **Human and Divine** — Scripture holds together human authorship and divine inspiration
- **Ancient** — honor the original ancient Near Eastern and Greco-Roman contexts
- **Unified** — trace intertextual connections across books, authors, and testaments
- **Wisdom** — the Bible trains readers in wisdom and character transformation, not just information
- **Meditation** — designed for slow re-reading that reveals layers of meaning over time

Notes follow a simple rule: think "margin scribble" not "commentary." One punchy observation per verse. Vary the angle — wordplay in the original language, an intertextual echo, ancient cultural context, narrative placement. Pick one. Don't moralize. Just illuminate.

Rendered verses are cached and version-stamped. The version is a SHA of the model and system prompt, so when either evolves, all cached renders auto-invalidate and re-render on next request.

## Core values

> Wonder over certainty. Humility before the text. Depth without jargon. Accessibility without dumbing down. Faithfulness to the text over novelty.

## How it's built

Node and Express. Vanilla JavaScript on the client (~600 lines). Zero frameworks. Mobile-only by design.

- **Swipe navigation** with spring physics — three panels always loaded (previous, current, next) for instant gesture response
- **Tap-to-expand notes** — tap any verse to reveal its margin note with a smooth animation
- **Dark and light themes** — automatic via `prefers-color-scheme`, no toggle needed
- **Performance** — CSS inlined at build time, JS fingerprinted with content hash for immutable caching, adjacent chapters prefetched during idle time, ETag support for 304 responses
- **SEO** — auto-generated sitemap for all 1,189 chapters, JSON-LD structured data, dynamic Open Graph tags per chapter
- **Security** — CSP, HSTS, rate limiting (30 req/min), HTML escaping on all dynamic content
- **Logging** — structured JSONL server logs (7-day retention), anonymous analytics (30-day retention)

## Run locally

```
npm install
XAI_API_KEY=your-key node server.js
```

Runs on port 3000. Open on a mobile device or a browser window narrower than 480px.

## Deploy

Configured for [Railway](https://railway.app) via `railway.json`. Health check at `/health`. Set `XAI_API_KEY` as an environment variable.

## Project structure

```
server.js            Express server, system prompt, rendering pipeline, caching, SEO
public/
  index.html         Single-page app template
  app.js             Client application
  style.css          All styling (inlined into HTML at startup)
  manifest.json      PWA manifest
data/
  bible.json         66 books with chapter and verse counts
renders/             Cached verse renders (per-book JSON files)
logger.js            Structured server logging
analytics.js         Anonymous event analytics
railway.json         Deployment configuration
```
