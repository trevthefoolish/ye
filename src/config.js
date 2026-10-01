// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Every environment variable the server reads, parsed in one place.

const path = require('node:path');
const { parsePositiveInt } = require('./text');

const ROOT = path.resolve(__dirname, '..');

const PIPELINE_VERSE = 'verse-v1';
const PIPELINE_SECTION = 'section-v2';

// Both pipelines use the Responses API (Chat Completions is legacy at xAI).
const XAI_RESPONSES_URL = 'https://api.x.ai/v1/responses';

// Unset and blank both mean "use the default"; stray whitespace is not a
// different model.
const setting = (value, fallback) => (typeof value === 'string' && value.trim()) || fallback;

function loadConfig(env = process.env) {
  // Section rendering is opt-in; anything else means the production default.
  const pipeline = setting(env.RENDER_PIPELINE) === PIPELINE_SECTION ? PIPELINE_SECTION : PIPELINE_VERSE;

  return Object.freeze({
    root: ROOT,
    port: env.PORT || 3000,
    production: env.NODE_ENV === 'production',
    origin: 'https://www.vapourware.ai',
    logs: Object.freeze({
      dir: env.LOG_DIR ? path.resolve(env.LOG_DIR) : path.join(ROOT, 'logs'),
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
      concurrency: parsePositiveInt(env.RENDER_CONCURRENCY, 8),
      verseTimeoutMs: 30_000,
      sectionTimeoutMs: parsePositiveInt(env.RENDER_SECTION_TIMEOUT_MS, 90_000),
      retries: 2,
      retryBaseMs: 1_000,
      // How long clients should wait before polling a partially rendered chapter.
      retryAfterMs: 2_000,
    }),
    cache: Object.freeze({
      // Cache root; each render version gets its own subdirectory. Production
      // points this at the volume; locally it is a gitignored directory.
      dir: setting(env.RENDERS_DIR) ? path.resolve(env.RENDERS_DIR.trim()) : path.join(ROOT, '.cache', 'renders'),
      // The committed renders/ (reviewed copies of production's cache) seeds
      // the cache at startup. The server only reads it.
      seedDir: path.join(ROOT, 'renders'),
      seed: env.SEED_RENDER_CACHE !== '0',
    }),
  });
}

module.exports = { loadConfig, PIPELINE_SECTION, PIPELINE_VERSE };
