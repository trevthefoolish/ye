// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Chapter-level rendering on top of a pipeline, the store, and the scheduler.
//
// A chapter request with missing verses asks the pipeline for work units
// (passages) and submits them to the shared scheduler. Each verse goes into
// the store as provisional text as soon as it streams in, so polling clients
// see verses appear one by one, and the validated passage then replaces it as
// final text. Rendering never runs ahead of requests: only chapters someone
// asked for (or the client prefetches) are rendered.
//
// A failed attempt drops its provisional text, and units that fail after
// retries leave their verses missing; the next request for the chapter plans
// them again. So final text always comes whole from one validated call.

const { createScheduler, FOREGROUND, BACKGROUND } = require('./scheduler');
const { emptyUsage } = require('./xai');

const refKey = ({ bookIndex, chapter, verse }) => `${bookIndex}:${chapter}:${verse}`;

function summarize(values) {
  const nums = values.filter(n => typeof n === 'number' && Number.isFinite(n));
  if (nums.length === 0) return { avg: 0, p95: 0, max: 0 };
  const sorted = [...nums].sort((a, b) => a - b);
  return {
    avg: Math.round(nums.reduce((sum, n) => sum + n, 0) / nums.length),
    p95: Math.round(sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

// `unit` names what one timing covers (a passage): avgPassageMs, p95PassageMs, ...
function timingSummary(timings, unit) {
  const cap = unit[0].toUpperCase() + unit.slice(1);
  const total = summarize(timings.map(t => t?.totalMs));
  const api = summarize(timings.map(t => t?.apiMs));
  return {
    [`avg${cap}Ms`]: total.avg,
    [`p95${cap}Ms`]: total.p95,
    [`max${cap}Ms`]: total.max,
    avgQueueMs: summarize(timings.map(t => t?.queueMs)).avg,
    avgApiMs: api.avg,
    maxApiMs: api.max,
  };
}

function createRenderer({ pipeline, store, log, concurrency, retries, retryBaseMs }) {
  const chapterJobs = new Map();
  const scheduler = createScheduler({
    concurrency,
    retries,
    retryBaseMs,
    onRetry: (unit, err, delayMs) => log.warn(`${pipeline.unit}_render_retry`, {
      ...unit.meta.logFields,
      attempt: unit.attempts,
      delay: delayMs,
      reason: err.message,
      ...err.timing,
    }),
  });

  // Runs inside a scheduler slot, once per attempt. Skips the API call if
  // another unit already finalized every ref between planning and now.
  // Streamed verses of the unit's own refs are staged as provisional text,
  // and the validated passage is stored as final text, replacing them. Final
  // text is never written over. A failed attempt's provisional text is
  // dropped at once, so no reader is shown it beside a retry's.
  async function runUnit(unit, usage) {
    if (unit.refs.every(ref => store.has(ref))) return [];
    const planned = new Set(unit.refs.map(refKey));
    const open = entries => entries.filter(entry => planned.has(refKey(entry)) && !store.has(entry));
    try {
      const entries = open(await unit.render(usage, streamed => store.stage(open(streamed))));
      store.put(entries);
      return entries;
    } catch (err) {
      store.unstage(unit.refs);
      throw err;
    }
  }

  // A unit already in the scheduler is joined, not resubmitted; only the
  // submission that created it logs its failure.
  function submitUnits(units, priority, usage) {
    const submitted = scheduler.submit(units.map(unit => ({ key: unit.key, task: () => runUnit(unit, usage), meta: unit })), priority);
    return submitted.map(({ status, promise }, i) => {
      if (status === 'started') {
        promise.catch(err => log.warn(`${pipeline.unit}_render_failed`, { ...units[i].logFields, reason: err.message, ...err.timing }));
      }
      return promise;
    });
  }

  async function renderChapter(ref, missing, job) {
    const units = pipeline.plan(ref, missing);
    job.unitKeys = units.map(unit => unit.key);
    const startedAt = Date.now();
    log.info('chapter_render_started', {
      book: ref.book,
      ch: ref.chapter,
      missing: missing.length,
      priority: job.priority,
      renderConcurrency: concurrency,
      renderPipeline: pipeline.name,
      units: units.length,
    });
    const usage = emptyUsage();
    const results = await Promise.allSettled(submitUnits(units, job.priority, usage));
    let rendered = 0;
    let failed = 0;
    const timings = results.map((result, i) => {
      if (result.status === 'fulfilled') {
        rendered += result.value.result.length;
        return result.value.timing;
      }
      failed += units[i].refs.length;
      return result.reason?.timing;
    });
    log.info('chapter_render_finished', {
      book: ref.book,
      ch: ref.chapter,
      durationMs: Date.now() - startedAt,
      rendered,
      failed,
      missing: missing.length,
      renderPipeline: pipeline.name,
      units: units.length,
      ...timingSummary(timings, pipeline.unit),
      ...usage,
    });
  }

  // Starts (or reprioritizes) rendering for a chapter's missing verses.
  // Returns 'started' | 'started-background' | 'promoted' | 'inflight'.
  function request(ref, missing, priority) {
    const key = `${ref.bookIndex}:${ref.chapter}`;
    const existing = chapterJobs.get(key);
    if (existing) {
      const promoted = priority === FOREGROUND && existing.priority !== FOREGROUND;
      if (promoted) existing.priority = FOREGROUND;
      return scheduler.touch(existing.unitKeys, priority) === 'promoted' || promoted ? 'promoted' : 'inflight';
    }
    const job = { priority, unitKeys: [] };
    chapterJobs.set(key, job);
    renderChapter(ref, missing, job)
      .catch(err => log.error('chapter_render_failed', { book: ref.book, ch: ref.chapter, err: err.message }))
      .finally(() => chapterJobs.delete(key));
    return priority === BACKGROUND ? 'started-background' : 'started';
  }

  return { request };
}

module.exports = { createRenderer, FOREGROUND, BACKGROUND };
