# vapourware.ai — agent guide

A mobile-only Bible reader that renders every verse in modern English, with a margin note, through Grok. The project is small, frameworkless, and opinionated about its voice. `README.md` covers what it does, configuration, deploy, and the file map; this file covers how to change it safely.

## Architecture

`server.js` wires three layers, each depending only on the ones above it:

1. **Foundations** (`src/config.js`, `canon.js`, `text.js`, `log.js`). Chapters and verses are 1-based everywhere except the store's file keys.
2. **Rendering** (`src/render/`). `renderer.js` asks the pipeline (`passage-v1.js`) to `plan(chapterRef, missingVerses)` into units `{ key, refs, logFields, render(usage, onVerses) }` and submits them to `scheduler.js`. As a call streams (`xai.js` streams every call), the pipeline hands each verse over once the next one has closed after it, in order and well-formed, stopping at the first gap, repeat, or malformed one; the renderer stages those in `store.js` as provisional text, then stores the validated passage as final text. The scheduler dedupes by key, runs foreground before background (background starts whenever slots are free but never takes the half kept for foreground, since a running call cannot be taken back), then most recently requested first, then submission order; it retries with backoff unless an error says `retryable: false`. The store serves reads from memory and persists with tmp+rename, coalesced per book.
3. **HTTP** (`src/http/`) and the **client** (`client/`, compiled into the page shell at startup; `public/` is served as-is). `client/app.js` is one IIFE: telemetry, canon (every chapter has a flat index `p`), motion constants, a chapter store (fetch dedupe, polling with backoff and caps), `Panel` (one chapter per swipe panel; swaps skeleton lines for verses as they arrive, and follows provisional verses until they are final), and the reader (pager, gestures, navigator, history).

## Invariants

Load-bearing. Don't break them:

- **The render version is pinned.** `test/render-version.test.js` pins it (`cbb178136416`). Anything that moves it (model, effort, prompt text, schema, passage size, the `passage-v1` name, even a refactor of how they are hashed) points production at an empty directory and re-renders, and re-bills, the whole Bible as people read it. Change the pin only on purpose, and say so in the PR.
- **Never serve or delete another version.** Entries are served only when their stamp matches the running version; other versions' directories are left for an operator.
- **The prompt stays short.** `prompts/passage-v1.md` describes the situation rather than adding rules; a test keeps it under 120 words and free of MUST/NEVER. Anything the app needs regardless goes in code.
- **House style is code.** `cleanText()` in `src/text.js` turns em dashes into commas and "vapor" into "vapour" (keeping case) on every model string, both when it is rendered and when stored text is served, so a house-style fix reaches verses stored before it without rewriting them. Keep it idempotent.
- **Rendered text never changes under a reader.** A passage is rendered whole for context, but only its missing verses are stored, and final text is never written over. Streamed verses are provisional (served with `provisional: true`, never saved or final, never in a cacheable response) until their passage passes its check; a failed attempt's are dropped at once and the retry streams afresh, so stored text always comes whole from one validated call. The client never changes a final verse it is showing; a provisional one follows the server, replaced or turned back into a skeleton.
- **Rendering follows demand.** Never pre-render the Bible. Failed units leave their verses missing and retryable by the next request.
- **Model text is never trusted.** Template placeholders are `{{escaped}}` by default; `{{{raw}}}` is only for `jsonForScript()` output or trusted static assets.
- **Page shell.** CSS is inlined and JS is served under a content hash with immutable caching. No `<link rel="stylesheet">`, no unhashed scripts.
- **Security headers.** CSP (`default-src 'self'`, no inline script), `X-Frame-Options: DENY`, HSTS in production. Beacons are rate-limited per IP (30/min `/api/log`, 60/min `/api/ev`); the chapter API is not, because the scheduler's concurrency cap protects the upstream.
- **URLs** are `/{book-slug}/{chapter}` (`1-kings`, `song-of-solomon`). The `lastPos` cookie (`bookIndex:chapterIndex`, 0-based) sends `/` back to where the reader left off.
- **Mobile-only.** Wider than 480px shows a message and the reader never starts. Intentional.
- **Themes** follow `prefers-color-scheme`, no toggle. Check both.
- **Fibonacci Symmetry Engine** (`--base: 3px`): spacing is `Fib(n) × 3px`, timing `Fib(n) × 50ms`. Use the tokens in `client/style.css :root`; gesture physics live in `client/app.js`.

## Patterns

- No frameworks, and no new npm dependencies without strong justification.
- Dependencies are passed in (`log`, `store`, `fetchImpl`, ...) so tests can use `memoryLogger()` and fakes.
- Log with `log.info|warn|error|debug(event, data)`, snake_case event names.

## Testing changes

1. `npm test`: unit suites plus end-to-end tests that spawn `server.js` against a mock xAI. No network needed.
2. For client changes, run the server and check a phone-sized window in both themes: a cold chapter (skeleton, then verses filling in as they stream), a verse tapped while still rendering (the note stays open), swipes both ways and at both ends of the Bible, the navigator, then Back.

---

Copyright (c) 2026 vapourware.ai All rights reserved.

No part of this software may be reproduced, distributed, or transmitted in any form or by any means without the prior written permission of vapourware.ai
