// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Every environment variable the server reads, parsed in one place.

const path = require('node:path');
const { parsePositiveInt } = require('./text');

const ROOT = path.resolve(__dirname, '..');

const PIPELINE_PASSAGE = 'passage-v1';
const PIPELINE_VERSE = 'verse-v1';
const PIPELINES = [PIPELINE_PASSAGE, PIPELINE_VERSE];

// Every pipeline uses the Responses API (Chat Completions is legacy at xAI).
const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

// Unset and blank both mean "use the default"; stray whitespace is not a
// different model.
const setting = (value, fallback) => (typeof value === 'string' && value.trim()) || fallback;

function loadConfig(env = process.env) {
  // passage-v1 in production; the older pipelines stay selectable by name.
  const requested = setting(env.RENDER_PIPELINE);
  const pipeline = PIPELINES.includes(requested) ? requested : PIPELINE_PASSAGE;
  // Railway sets this when a volume is attached; renders and logs live there
  // unless RENDERS_DIR / LOG_DIR say otherwise.
  const volume = setting(env.RAILWAY_VOLUME_MOUNT_PATH);
  const persistent = (name, fallback) => (setting(env[name]) ? path.resolve(env[name].trim()) : volume ? path.join(volume, fallback) : null);

  return Object.freeze({
    root: ROOT,
    port: env.PORT || 3000,
    production: env.NODE_ENV === 'production',
    origin: 'https://www.vapourware.ai',
    logs: Object.freeze({
      dir: persistent('LOG_DIR', 'logs') || path.join(ROOT, 'logs'),
      debug: env.LOG_LEVEL === 'debug' || env.NODE_ENV !== 'production',
      // Optional: hardens the daily anonymous analytics id against brute-forcing the IP space.
      analyticsSalt: env.ANALYTICS_SALT || '',
    }),
    render: Object.freeze({
      pipeline,
      apiKey: env.XAI_API_KEY || '',
      apiUrl: env.XAI_API_URL || XAI_RESPONSES_URL,
      model: setting(env.RENDER_MODEL, 'grok-4.7'),
      // grok-4.7 accepts low|medium|high|xhigh (default high) and cannot turn
      // reasoning off. low is xAI's setting for latency-sensitive work, and
      // reasoning tokens bill as output, so it is also the cheapest.
      reasoningEffort: setting(env.RENDER_REASONING_EFFORT, 'low'),
      // Upstream calls in flight at once, across all readers. A verse takes
      // ~20 s, so this is the throughput dial: 32 renders an average chapter
      // (26 verses) in one round. xAI rate limits answer 429, which is retried.
      concurrency: parsePositiveInt(env.RENDER_CONCURRENCY, 32),
      // grok-4.7 reasons even at low effort: in production a single verse
      // averaged ~20 s and a quarter of calls ran past 30 s. A timeout cuts off
      // (and re-bills) a call that would have succeeded, so leave headroom.
      verseTimeoutMs: 90_000,
      // A passage call reasons over up to 10 verses and writes them all.
      passageTimeoutMs: 120_000,
      retries: 2,
      retryBaseMs: 1_000,
      // How long clients should wait before polling a partially rendered chapter.
      retryAfterMs: 2_000,
    }),
    cache: Object.freeze({
      // Cache root; each render version gets its own subdirectory. On Railway
      // it is on the volume; locally it is a gitignored directory.
      dir: persistent('RENDERS_DIR', 'renders') || path.join(ROOT, '.cache', 'renders'),
      // Where section-v2 renders lived before Grok 4.7 (the old docs had
      // RENDERS_DIR=/data/renders-v2). Removed at startup unless in use.
      retiredDirs: volume ? [path.join(volume, 'renders-v2')] : [],
      // The committed renders/ (reviewed copies of production's cache) seeds
      // the cache at startup. The server only reads it.
      seedDir: path.join(ROOT, 'renders'),
      seed: env.SEED_RENDER_CACHE !== '0',
    }),
  });
}

module.exports = { loadConfig, PIPELINE_PASSAGE, PIPELINE_VERSE };
