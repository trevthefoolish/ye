# vapourware.ai

**v0.0.1**

*Absolute vapour, says the Teacher, absolute vapour. Everything is vapour.*
— Ecclesiastes 1:2

**vapour** + **ware**. The Hebrew word *hevel* — that morning mist above the garden, the breath God breathed into clay. Everything is vapour, but He is not.

vapourware.ai renders the entire Bible in modern English with illuminating margin notes. Every verse is translated with care for the original Hebrew, Aramaic, and Greek. Every note is a curious scribble in the margin — one surprising thing about the text, not a sermon.

It's designed for deep, repeated reading. The kind that reveals its meaning over a lifetime.

> Wonder over certainty. Humility before the text. Depth without jargon. Accessibility without dumbing down. Faithfulness to the text over novelty.

## How it works

The Bible is rendered on demand by [Grok](https://x.ai) (`grok-4.7` at low reasoning effort), a passage at a time: each chapter splits into near-even passages of at most 10 verses, and each passage is one call to xAI's Responses API with strict JSON-schema output. The prompt ([`prompts/passage-v1.md`](prompts/passage-v1.md)) is short on purpose: who is reading, what to write for each verse, and the app's one opinion, that the Bible is one story that leads to Jesus. The only house style, no em dashes and "vapour" with a *u*, is applied in code.

A chapter request returns whatever is already rendered and queues the rest; the reader polls, and verses appear one by one as the model writes them, since each call streams and every verse is stored once the model has moved on to the next. Nothing renders ahead of demand: only chapters someone opens (and their neighbours, at lower priority) go to the model. Neighbours render alongside the open chapter while upstream slots are free, but never in the half of the slots kept for chapters readers open.

Renders are cached per **render version**, a hash of the model, reasoning effort, prompt, schema, and passage size:

```
RENDERS_DIR/<render version>/<book index>.json    keys "chapterIndex:verseIndex" (0-based)
```

Changing any of those starts an empty directory, and the Bible re-renders as people read it (3,664 calls for all of it). Changing back finds the old directory untouched; at startup the server logs the other versions it finds (`render_cache_prepared.otherVersions`) so you can delete them by hand. `/api/version` reports the running version.

Node 22 and Express 5 on the server; one plain-JavaScript file on the client, minified at startup. Mobile-only by design, with automatic dark and light themes.

## Run locally

```
npm install
XAI_API_KEY=your-key npm start   # http://localhost:3000, in a window narrower than 480px
npm test                         # unit and end-to-end tests; xAI is mocked
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `XAI_API_KEY` | (required) | xAI credentials |
| `PORT` | `3000` | Listen port (`0` picks a free one) |
| `NODE_ENV` | `production` in the Docker image | Enables HSTS, secure cookies, and quieter logs |
| `RENDER_MODEL` | `grok-4.7` | Model (part of the render version) |
| `RENDER_REASONING_EFFORT` | `low` | `low`, `medium`, `high`, or `xhigh`; reasoning bills as output (part of the render version) |
| `RENDER_CONCURRENCY` | `32` | Max concurrent upstream calls; prefetches may use half of them (rounded up) |
| `XAI_API_URL` | `https://api.x.ai/v1/responses` | xAI endpoint (tests point it at a mock) |
| `RENDERS_DIR` | `<volume>/renders` on Railway, else `./.cache/renders` | Render cache root |
| `LOG_DIR` | `<volume>/logs` on Railway, else `./logs` | JSONL logs: server 7 days, anonymous analytics 30 |
| `LOG_LEVEL` | | `debug` keeps debug lines in production |
| `ANALYTICS_SALT` | | Hardens the daily anonymous analytics id |

## Deploy

[Railway](https://railway.app) builds the `Dockerfile` (`railway.json`), health-checked at `/health`. The service needs one variable, `XAI_API_KEY`, and a volume at any mount path: the server finds it through `RAILWAY_VOLUME_MOUNT_PATH` and keeps renders and logs there. On `SIGTERM` it stops accepting connections and lets pending cache writes land.

## Project structure

```
server.js            Entry point: wires config, logs, cache, pipeline, and web app
src/
  config.js          Every environment variable, parsed once
  canon.js           Books, chapters, verse counts, URL slugs
  text.js            House style (cleanText), escaping, hashing
  log.js             JSONL logging with retention
  render/
    passage-v1.js    The pipeline: passages, prompt, schema, render version
    xai.js           Streaming xAI client and error classification
    scheduler.js     Bounded upstream pool: dedupe, priority with a foreground reserve, recency, retries
    renderer.js      Chapter requests -> passage units -> cache verse by verse, with timing logs
    store.js         Render cache: per-version directories of per-book JSON
  http/
    app.js           Express app: security headers, routes, errors
    api.js           /api/chapter and /api/version
    pages.js         Chapter pages, root redirect, robots.txt, sitemap
    shell.js         Page shell: inlined CSS, hashed JS, template
    telemetry.js     /api/log (client errors) and /api/ev (analytics)
client/              index.html, app.js, style.css (compiled into the shell at startup)
public/              Served as-is (icons, manifest)
prompts/             The system prompt (part of the render version)
data/bible.json      66 books with per-chapter verse counts
test/                node:test suites
```

Working on the code? Read [`AGENTS.md`](AGENTS.md) for the invariants.

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
