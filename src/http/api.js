// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// GET /api/chapter/:book/:chapter
//   Complete chapters: { verses, complete: true, missingCount: 0 }, cacheable
//   for a day with an ETag. Partial chapters: rendered verses (null where
//   missing) plus a retry hint; the request also queues the missing verses.
//   Query: priority=background (or low) for prefetches; render=0 to only read.
//
// GET /api/version — what is rendering, and the cache key it stamps.

const express = require('express');
const { resolveChapter } = require('../canon');
const { BACKGROUND, FOREGROUND } = require('../render/scheduler');

const ONE_DAY = 'public, max-age=86400';
const NO_RENDER = new Set(['0', 'false', 'cache-only']);

// null means "read only". ?render= doubles as a priority hint when ?priority= is absent.
function renderPriority(query) {
  const render = String(query.render || '1').toLowerCase();
  if (NO_RENDER.has(render)) return null;
  const priority = String(query.priority || render).toLowerCase();
  return priority === BACKGROUND || priority === 'low' ? BACKGROUND : FOREGROUND;
}

function apiRoutes({ store, renderer, pipeline, render, appVersion }) {
  const router = express.Router();

  router.get('/api/chapter/:book/:chapter', (req, res) => {
    const ref = resolveChapter(req.params.book, req.params.chapter);
    if (!ref) return res.status(400).json({ error: 'invalid book or chapter' });

    const complete = store.completeChapter(ref);
    if (complete) {
      res.setHeader('Cache-Control', ONE_DAY);
      res.setHeader('ETag', complete.etag);
      if (req.headers['if-none-match'] === complete.etag) return res.status(304).end();
      return res.type('json').send(complete.body);
    }

    const { verses, missing } = store.chapter(ref);
    const priority = renderPriority(req.query);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      verses,
      complete: false,
      missingCount: missing.length,
      retryAfterMs: render.retryAfterMs,
      renderQueued: priority ? renderer.request(ref, missing, priority) : 'skipped',
      renderPriority: priority || 'none',
    });
  });

  router.get('/api/version', (req, res) => {
    res.setHeader('Cache-Control', ONE_DAY);
    res.json({
      version: pipeline.version,
      model: render.model,
      reasoningEffort: render.reasoningEffort,
      renderPipeline: pipeline.name,
      appVersion,
    });
  });

  router.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

  return router;
}

module.exports = { apiRoutes };
