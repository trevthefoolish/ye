# vapourware.ai

**v0.0.1**

*Absolute vapour, says the Teacher, absolute vapour. Everything is vapour.*
— Ecclesiastes 1:2

**vapour** + **ware**. The Hebrew word *hevel* — that morning mist above the garden, the breath God breathed into clay. Everything is vapour, but He is not.

vapourware.ai renders the entire Bible in modern English with illuminating margin notes. Every verse is translated with care for the original Hebrew, Aramaic, and Greek. Every note is a curious scribble in the margin — one surprising thing about the text, not a sermon.

It's designed for deep, repeated reading. The kind that reveals its meaning over a lifetime.

## How it works

Each verse is rendered on demand by [Grok](https://x.ai) (Grok 4.5 by default, overridable via `RENDER_MODEL`) through a theological framework built on seven lenses:

- **Messianic** — every narrative thread contributes to the story that finds fulfillment in Jesus
- **Communal** — the Bible addresses communities and peoples, not just isolated individuals
- **Human and Divine** — Scripture holds together human authorship and divine inspiration
- **Ancient** — honor the original ancient Near Eastern and Greco-Roman contexts
- **Unified** — trace intertextual connections across books, authors, and testaments
- **Wisdom** — the Bible trains readers in wisdom and character transformation, not just information
- **Meditation** — designed for slow re-reading that reveals layers of meaning over time

Notes follow a simple rule: a Christian reader with good taste penciling sharp observations in the margin. One useful thing per verse. It might be a word, image, pattern, tension, literary move, ancient context, canonical thread, or worthy Christ-shaped connection. Don't moralize. Just illuminate.

A chapter request returns whatever is already rendered and queues the rest; the reader polls and verses appear as they finish. Nothing renders ahead of demand: only chapters someone opens (and their neighbours, prefetched at lower priority) are sent to the model.

There are two render pipelines:

- **`verse-v1`** (production default) — one Chat Completions call per verse, given only the reference.
- **`section-v2`** (opt-in, `RENDER_PIPELINE=section-v2`) — one Responses API call per pericope section from `data/sections.json`, so notes can see their context. Sections may cross chapters; one call fills every chapter it touches. Still eval-only: see [Renderer v2 evals](#renderer-v2-evals).

## Core values

> Wonder over certainty. Humility before the text. Depth without jargon. Accessibility without dumbing down. Faithfulness to the text over novelty.

## How it's built

Node 22 and Express 5 on the server, plain browser JavaScript on the client (one file, no frameworks, no build step beyond minification at startup). Mobile-only by design.

- **Fibonacci Symmetry Engine** — spacing is `Fib(n) × 3px`, timing is `Fib(n) × 50ms`, so each step is about φ times the last. The scale lives in `client/style.css :root`.
- **Swipe navigation** — three panels (previous, current, next) always in the DOM for instant response, with velocity-aware spring physics.
- **Tap-to-expand notes** — tap any verse to reveal its margin note.
- **Dark and light themes** — automatic via `prefers-color-scheme`, no toggle.
- **Performance** — CSS inlined into the page, JS minified and served under a content-hashed URL with immutable caching, the opening chapter inlined into the HTML, neighbours prefetched in the background, ETags on complete chapters.
- **SEO** — sitemap of all 1,189 chapters, per-chapter titles, descriptions, canonical URLs, Open Graph tags, and JSON-LD.
- **Security** — strict CSP, HSTS, escaped output everywhere model text reaches HTML, rate-limited beacon endpoints, and one global cap on concurrent upstream render calls.
- **Logging** — structured JSONL server logs (7-day retention) and anonymous analytics (30-day retention).

## Run locally

```
npm install
XAI_API_KEY=your-key npm start
```

Runs on port 3000. Open it on a phone or in a browser window narrower than 480px. Before sending a change:

```
npm run check   # syntax-checks every JS file
npm test        # unit and end-to-end tests (no network; xAI is mocked)
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `XAI_API_KEY` | (required) | xAI credentials |
| `PORT` | `3000` | Listen port (`0` picks a free one) |
| `NODE_ENV` | | `production` enables HSTS, secure cookies, and quieter logs |
| `RENDER_PIPELINE` | `verse-v1` | `section-v2` opts into the section renderer |
| `RENDER_MODEL` | `grok-4.5` | Model for both pipelines |
| `RENDER_REASONING_EFFORT` | `low` | Grok 4.5 accepts `low`, `medium`, `high` |
| `RENDER_CONCURRENCY` | `8` | Max concurrent upstream render calls |
| `RENDER_SECTION_TIMEOUT_MS` | `90000` | Per-call timeout for `section-v2` (`verse-v1` uses 30 s) |
| `XAI_API_URL` | per pipeline | Override the xAI endpoint (tests point it at a mock) |
| `RENDERS_DIR` | `./renders` | Render cache directory |
| `SEED_RENDER_CACHE` | on | `0` skips seeding `RENDERS_DIR` from `renders/` at startup |
| `LOG_DIR` | `./logs` | JSONL log directory |
| `LOG_LEVEL` | | `debug` keeps debug lines in production |
| `ANALYTICS_SALT` | | Hardens the daily anonymous analytics id |

## The render cache

Renders are stored as one JSON file per book, keyed by `chapterIndex:verseIndex` (0-based), and every entry is stamped with the **render version** that produced it. Only entries matching the running version are served; anything else is treated as missing and re-rendered on demand. Nothing is ever deleted, so rolling back a model or prompt change brings its renders straight back.

The render version is a hash of everything that shapes the output:

- `verse-v1`: model + prompt (`prompts/verse-v1.md`). Reasoning effort is *not* included.
- `section-v2`: model, reasoning effort, prompt (`prompts/margin-note-v3.md`), schema version, and the section map's version and content fingerprint.

Changing any of those re-renders the whole Bible as people read it, at one API call per verse (or section). `test/render-version.test.js` pins the current versions so that a refactor can't do this by accident. If a change is meant to re-render, update the pin and say so in the PR.

The committed `renders/` directory seeds the cache volume at startup: entries matching the running version are merged in, and live-only entries are kept. Most of it was produced by `grok-4.20-0309-non-reasoning` (`ff54612cf1f0`), so under the Grok 4.5 default it is historical reference until refreshed. `/api/version` reports the running version. To pull production renders back into the repository for review:

```
./scripts/sync-railway-renders.sh
```

## Deploy

Configured for [Railway](https://railway.app) via `railway.json`. Health check at `/health`. Production variables:

```
XAI_API_KEY=...
NODE_ENV=production
RENDERS_DIR=/data/renders
LOG_DIR=/data/logs
```

Mount a Railway volume at `/data` so the render cache and logs survive deploys. On `SIGTERM` the server stops accepting connections and lets pending cache writes land before exiting.

Upgrading the model rotates the render version. To keep serving an existing Grok 4.3 cache instead, pin the previous behaviour:

```
RENDER_MODEL=grok-4.3
RENDER_REASONING_EFFORT=none
```

## Renderer v2 evals

`section-v2` stays off in production until its eval output is reviewed. The eval script renders a fixed scenario set through the section pipeline, prints note metrics, and writes Markdown and JSON reports under `eval-reports/` (gitignored) or `EVAL_REPORTS_DIR`. It never writes the render cache. Run it with Railway's production variables without changing the live service:

```
railway run --service ye --environment production -- npm run eval:v2            # 15 verses (smoke)
railway run --service ye --environment production -- npm run eval:v2:edge       # 171 edge-case verses
railway run --service ye --environment production -- npm run eval:v2:prod-sim   # production section grouping
railway run --service ye --environment production -- npm run eval:v2:gate       # edge set, fails on hard errors
```

The gate fails only on structural problems: incomplete schema, em dashes or "vapor" after cleanup, duplicate/missing/unexpected refs, or missing report metadata. Christ-connection review stays manual. Scenario metadata (`data/eval-scenarios.json`) groups the report; it is never sent to the model. Prefer `EVAL_REPORTS_DIR=/tmp/...` for exploratory runs and attach reviewed reports to the PR.

The section map (`data/sections.json`) comes from `npm run sections:generate`, which prefers OpenBible consensus sections and fills any gap with small deterministic fallback sections, so every one of the 31,071 verses belongs to exactly one section.

When v2 is approved, flip it with a fresh cache directory:

```
RENDER_PIPELINE=section-v2
RENDERS_DIR=/data/renders-v2
```

Check that `/api/version` reports `section-v2`, then cold-load chapters covering consensus sections, fallback sections, cross-chapter sections, and adjacent-chapter swipes. Roll back by unsetting `RENDER_PIPELINE` and restoring `RENDERS_DIR=/data/renders`.

## Project structure

```
server.js                 Entry point: wires config, logs, cache, pipeline, and web app
src/
  config.js               Every environment variable, parsed once
  canon.js                Books, chapters, verse counts, slugs, and verse references
  text.js                 cleanText (house style), HTML/JSON escaping, small helpers
  log.js                  JSONL logging with retention
  render/
    store.js              Render cache: version-stamped per-book JSON files, seeding
    scheduler.js          Bounded upstream pool: dedupe, priority, recency, retries
    renderer.js           Chapter requests -> work units -> cache, with timing logs
    xai.js                xAI HTTP client and error classification
    verse-v1.js           Production pipeline (one call per verse)
    section-v2.js         Section pipeline and section map
    section-eval.js       Eval scenarios for section-v2
  http/
    app.js                Express app: security headers, routes, error handling
    api.js                /api/chapter and /api/version
    pages.js              Chapter pages, root redirect, robots.txt, sitemap
    shell.js              Builds the page shell (inlined CSS, hashed JS, template)
    telemetry.js          /api/log (client errors) and /api/ev (analytics)
client/                   Page shell sources, compiled at startup
  index.html              Template: {{escaped}} and {{{raw}}} placeholders
  app.js                  The reader
  style.css               All styling and design tokens
public/                   Served as-is (icons, manifest)
prompts/                  System prompts (part of the render version)
data/
  bible.json              66 books with per-chapter verse counts
  sections.json           Section map for section-v2
  eval-scenarios.json     Eval-only scenario metadata
renders/                  Committed seed for the render cache
scripts/                  check, section generation, v2 eval, Railway render sync
test/                     node:test suites
```

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
