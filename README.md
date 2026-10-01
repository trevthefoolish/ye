# vapourware.ai

**v0.0.1**

*Absolute vapour, says the Teacher, absolute vapour. Everything is vapour.*
— Ecclesiastes 1:2

**vapour** + **ware**. The Hebrew word *hevel* — that morning mist above the garden, the breath God breathed into clay. Everything is vapour, but He is not.

vapourware.ai renders the entire Bible in modern English with illuminating margin notes. Every verse is translated with care for the original Hebrew, Aramaic, and Greek. Every note is a curious scribble in the margin — one surprising thing about the text, not a sermon.

It's designed for deep, repeated reading. The kind that reveals its meaning over a lifetime.

## How it works

Each verse is rendered on demand by [Grok](https://x.ai) (Grok 4.7 by default, overridable via `RENDER_MODEL`) through a theological framework built on seven lenses:

- **Messianic** — every narrative thread contributes to the story that finds fulfillment in Jesus
- **Communal** — the Bible addresses communities and peoples, not just isolated individuals
- **Human and Divine** — Scripture holds together human authorship and divine inspiration
- **Ancient** — honor the original ancient Near Eastern and Greco-Roman contexts
- **Unified** — trace intertextual connections across books, authors, and testaments
- **Wisdom** — the Bible trains readers in wisdom and character transformation, not just information
- **Meditation** — designed for slow re-reading that reveals layers of meaning over time

Notes follow a simple rule: a Christian reader with good taste penciling sharp observations in the margin. One useful thing per verse. It might be a word, image, pattern, tension, literary move, ancient context, canonical thread, or worthy Christ-shaped connection. Don't moralize. Just illuminate.

A chapter request returns whatever is already rendered and queues the rest; the reader polls and verses appear as they finish. Nothing renders ahead of demand: only chapters someone opens (and their neighbours, prefetched at lower priority) are sent to the model.

There are two render pipelines, both on xAI's Responses API with strict JSON-schema output and `store: false`:

- **`verse-v1`** (production default) — one call per verse, given only the reference.
- **`section-v2`** (opt-in, `RENDER_PIPELINE=section-v2`) — one call per pericope section from `data/sections.json`, so notes can see their context. Sections may cross chapters; one call fills every chapter it touches. Still eval-only: see [Renderer v2 evals](#renderer-v2-evals).

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
| `NODE_ENV` | `production` in the Docker image | `production` enables HSTS, secure cookies, and quieter logs |
| `RENDER_PIPELINE` | `verse-v1` | `section-v2` opts into the section renderer |
| `RENDER_MODEL` | `grok-4.7` | Model for both pipelines |
| `RENDER_REASONING_EFFORT` | `low` | Grok 4.7 accepts `low`, `medium`, `high`, `xhigh`; reasoning can't be turned off, and its tokens bill as output |
| `RENDER_CONCURRENCY` | `32` | Max concurrent upstream render calls |
| `RENDER_SECTION_TIMEOUT_MS` | `90000` | Per-call timeout for `section-v2` (`verse-v1` uses 90 s) |
| `XAI_API_URL` | `https://api.x.ai/v1/responses` | Override the xAI endpoint (tests point it at a mock) |
| `RENDERS_DIR` | `<volume>/renders` on Railway, else `./.cache/renders` (gitignored) | Render cache root; each render version gets its own subdirectory |
| `SEED_RENDER_CACHE` | on | `0` skips merging the committed `renders/<version>/` into the cache at startup |
| `LOG_DIR` | `<volume>/logs` on Railway, else `./logs` | JSONL log directory |
| `LOG_LEVEL` | | `debug` keeps debug lines in production |
| `ANALYTICS_SALT` | | Hardens the daily anonymous analytics id |

## The render cache

Renders are stored per **render version**, one JSON file per book:

```
RENDERS_DIR/<render version>/<book index>.json    keys "chapterIndex:verseIndex" (0-based)
```

The render version is a short hash of everything that shapes the output:

- `verse-v1`: model, reasoning effort, prompt (`prompts/verse-v1.md`), and response schema.
- `section-v2`: the same, plus the request's fixed task and constraints and the section map's version and content fingerprint.

Changing any of those starts a fresh, empty directory, and the Bible re-renders on demand as people read it, at one API call per verse (or section). Changing back finds the previous directory untouched, so a config change, a typo included, never destroys paid renders. At startup the server logs the other versions it finds (`render_cache_prepared.otherVersions`); delete those directories from the volume once you no longer want them. `test/render-version.test.js` pins the current versions so a refactor can't switch directories by accident; when a change is meant to, update the pin and say so in the PR. `/api/version` reports the running version.

The cache started fresh with Grok 4.7. Code before it kept every version mixed together in `RENDERS_DIR/<book index>.json`; the server deletes those flat files at startup. Only pre-4.7 code ever wrote them, so this happens once.

The committed `renders/<version>/` is a reviewed copy of production's cache for the current version. At startup it is merged into the cache (unless `SEED_RENDER_CACHE=0`); the server only reads it, and a test fails if it holds any other version. To mirror production's current version into it:

```
./scripts/sync-railway-renders.sh
```

## Deploy

Configured for [Railway](https://railway.app) via `railway.json`, built from the `Dockerfile`. Health check at `/health`. The service needs:

- **One variable:** `XAI_API_KEY`.
- **A volume** (any mount path, e.g. `/data`). Railway exposes it as `RAILWAY_VOLUME_MOUNT_PATH`, and the server keeps the render cache in `<volume>/renders` and logs in `<volume>/logs`, so both survive deploys.

Everything else has a production default (the image sets `NODE_ENV=production`; the pipeline is `verse-v1` on `grok-4.7`). Set the variables in the configuration table only to change those defaults. On `SIGTERM` the server stops accepting connections and lets pending cache writes land before exiting.

Upgrading from before Grok 4.7: delete every service variable except `XAI_API_KEY` (older setups had `NODE_ENV`, `LOG_DIR`, `RENDERS_DIR`, `RENDER_PIPELINE`, `RENDER_SECTION_TIMEOUT_MS`, and sometimes `RENDER_MODEL`/`RENDER_REASONING_EFFORT`). On first start the server removes the old flat cache files in `<volume>/renders` and the old section renderer's `<volume>/renders-v2`. `/api/version` should then report `verse-v1`, `grok-4.7`, effort `low`, and the version pinned in `test/render-version.test.js`.

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

When v2 is approved, flip it with `RENDER_PIPELINE=section-v2`. Its renders go to their own version directory, so check that `/api/version` reports `section-v2`, then cold-load chapters covering consensus sections, fallback sections, cross-chapter sections, and adjacent-chapter swipes. Roll back by unsetting `RENDER_PIPELINE`; the `verse-v1` directory is still there.

## Project structure

```
server.js                 Entry point: wires config, logs, cache, pipeline, and web app
src/
  config.js               Every environment variable, parsed once
  canon.js                Books, chapters, verse counts, slugs, and verse references
  text.js                 cleanText (house style), HTML/JSON escaping, small helpers
  log.js                  JSONL logging with retention
  render/
    store.js              Render cache: per-version directories of per-book JSON files
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
renders/                  Reviewed copy of production's cache for the current version (seed)
scripts/                  check, section generation, v2 eval, Railway render sync
test/                     node:test suites
```

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
