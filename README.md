# vapourware.ai

**v0.0.1**

*Absolute vapour, says the Teacher, absolute vapour. Everything is vapour.*
— Ecclesiastes 1:2

**vapour** + **ware**. The Hebrew word *hevel* — that morning mist above the garden, the breath God breathed into clay. Everything is vapour, but He is not.

vapourware.ai renders the entire Bible in modern English with illuminating margin notes. Every verse is translated with care for the original Hebrew, Aramaic, and Greek. Every note is a curious scribble in the margin — one surprising thing about the text, not a sermon.

It's designed for deep, repeated reading. The kind that reveals its meaning over a lifetime.

## How it works

Each verse is rendered on-demand by [Grok](https://x.ai) (Grok 4.5 by default, overridable via `RENDER_MODEL`) through a theological framework built on seven lenses:

- **Messianic** — every narrative thread contributes to the story that finds fulfillment in Jesus
- **Communal** — the Bible addresses communities and peoples, not just isolated individuals
- **Human and Divine** — Scripture holds together human authorship and divine inspiration
- **Ancient** — honor the original ancient Near Eastern and Greco-Roman contexts
- **Unified** — trace intertextual connections across books, authors, and testaments
- **Wisdom** — the Bible trains readers in wisdom and character transformation, not just information
- **Meditation** — designed for slow re-reading that reveals layers of meaning over time

Notes follow a simple rule: a Christian reader with good taste penciling sharp observations in the margin. One useful thing per verse. It might be a word, image, pattern, tension, literary move, ancient context, canonical thread, or worthy Christ-shaped connection. Don't moralize. Just illuminate.

Rendered verses are cached and version-stamped. The default production renderer is still the original one-verse pipeline. The experimental section renderer is gated behind `RENDER_PIPELINE=section-v2` so it can be evaluated without invalidating production cache by accident. V2 remains on-demand: it renders committed OpenBible-derived pericope sections as chapters request them, including cross-chapter sections, and writes each returned canonical ref into the correct per-book cache file. It does not pre-render the whole Bible.

## Core values

> Wonder over certainty. Humility before the text. Depth without jargon. Accessibility without dumbing down. Faithfulness to the text over novelty.

## How it's built

Node and Express. Vanilla JavaScript on the client (~600 lines). Zero frameworks. Mobile-only by design.

- **Fibonacci Symmetry Engine** — every spatial, timing, and opacity value derives from the Fibonacci sequence. Spatial: `Fib(n) × 3px`. Timing: `Fib(n) × 50ms`. Opacity: `Fib(n)/34`. Consecutive ratios converge on φ ≈ 1.618, grounded in Weber-Fechner perceptual law, Gestalt proximity, and Fitts's Law. See `style.css :root` for the full derivation.
- **Swipe navigation** with spring physics — three panels always loaded (previous, current, next) for instant gesture response
- **Tap-to-expand notes** — tap any verse to reveal its margin note with a smooth animation
- **Dark and light themes** — automatic via `prefers-color-scheme`, no toggle needed
- **Performance** — CSS inlined at server startup, JS fingerprinted with content hash for immutable caching, adjacent chapters prefetched during idle time, ETag support for 304 responses
- **SEO** — auto-generated sitemap for all 1,189 chapters, JSON-LD structured data, dynamic Open Graph tags per chapter
- **Security** — CSP, HSTS, HTML escaping on all dynamic content, rate limiting on the client log endpoint (30 req/min) and analytics endpoint (60 req/min), and a global concurrency cap on upstream render calls
- **Logging** — structured JSONL server logs (7-day retention), anonymous analytics (30-day retention)

## Run locally

```
npm install
XAI_API_KEY=your-key node server.js
```

Runs on port 3000. Open on a mobile device or a browser window narrower than 480px.

To run the guarded renderer v2 smoke eval with a local key:

```
XAI_API_KEY=your-key npm run eval:v2
```

For PR review, prefer running it locally with Railway production variables, without changing the live Railway service:

```
railway run --service ye --environment production -- npm run eval:v2
```

This renders exactly 15 reference-only verses through the section-aware Responses API path, prints note metrics, and writes Markdown plus JSON reports under `eval-reports/` (gitignored). To run the broader 171-verse edge-case set:

```
railway run --service ye --environment production -- npm run eval:v2:edge
```

To exercise the production section map without writing render cache files:

```
railway run --service ye --environment production -- npm run eval:v2:prod-sim
```

`npm run eval:v2:gate` runs the edge eval with release-blocking checks enabled. It fails only on hard structural problems: incomplete schema, cleaned em dashes, cleaned `vapor`, duplicate/missing/unexpected refs, or missing report metadata. Subjective Christ-connection review remains a manual review item.

Eval scenario metadata is used for report grouping only; it is not sent to the model and is not exposed from `/api/chapter`. Eval commands do not write render cache files. Prefer `EVAL_REPORTS_DIR=/tmp/...` for exploratory edge/prod-sim runs; `eval-reports/` is gitignored, so attach reviewed reports to the PR for review. Keep `RENDER_PIPELINE` unset in Railway production until v2 eval output is reviewed and accepted.

The v2 section map lives at `data/sections.json` and is generated by `npm run sections:generate` from OpenBible section-count data. OpenBible consensus sections are preferred. Any uncovered canonical refs are filled at generation time with deterministic `generated-fallback` sections, so runtime never has to invent a section and no valid verse can become permanently unrenderable.

## Deploy

Configured for [Railway](https://railway.app) via `railway.json`. Health check at `/health`.

Set these production variables:

```
XAI_API_KEY=...
NODE_ENV=production
RENDERS_DIR=/data/renders
LOG_DIR=/data/logs
```

Mount a Railway volume at `/data` so generated render cache and JSONL logs survive deploys and restarts. The committed `renders/` directory seeds the volume at startup, but only entries stamped with the current `RENDER_VERSION` merge in — after a model or prompt change it is historical reference until refreshed. Optionally set `ANALYTICS_SALT` to harden the anonymous analytics id against IP brute-forcing.

The renderer defaults to `grok-4.5` with `reasoning_effort: low` (Grok 4.5 dropped the `none` effort level that Grok 4.3 accepted). Changing the model or effort changes `RENDER_VERSION`, so verses re-render on demand and the old cache stops being served. To keep serving an existing Grok 4.3 cache, pin the previous behavior explicitly:

```
RENDER_MODEL=grok-4.3
RENDER_REASONING_EFFORT=none
```

For the first v2 production flip, use a fresh cache directory:

```
RENDER_PIPELINE=section-v2
RENDERS_DIR=/data/renders-v2
```

(`RENDER_SECTION_TIMEOUT_MS` defaults to 90000 and only needs setting to change it.)

Verify `/api/version` reports `section-v2`, then cold-request representative chapters that cover normal OpenBible sections, generated fallback sections, cross-chapter sections, and adjacent chapter transitions. Roll back by unsetting `RENDER_PIPELINE` and restoring `RENDERS_DIR=/data/renders`.

To bring production-generated renders back into GitHub for review, run:

```
./scripts/sync-railway-renders.sh
```

## Project structure

```
server.js            Express server, system prompt, rendering pipeline, caching, SEO
rendererV2.js        Experimental section renderer, schema, section grouping, eval helpers
public/
  index.html         Single-page app template
  app.js             Client application
  style.css          All styling (inlined into HTML at startup)
  manifest.json      PWA manifest
data/
  bible.json         66 books with chapter and verse counts
  sections.json      Production section map for renderer v2 grouping
  eval-scenarios.json Eval-only smoke, edge, and prod-sim coverage metadata
prompts/
  margin-note-v3.md  Longer margin-note prompt for the guarded v2 renderer
eval-reports/        Local eval output (gitignored; attach reviewed reports to PRs)
renders/             Cached verse renders (per-book JSON files)
logger.js            Structured server logging and anonymous event analytics
utils.js             Shared helpers (cleanText, escapeHtml, parsePositiveInt, slugify)
railway.json         Deployment configuration
```

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
