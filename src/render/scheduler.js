// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// A bounded pool for upstream render calls.
//
// Work is submitted as units with a stable key; submitting a key that is
// already queued, running, or waiting to retry joins the existing unit instead
// of starting a second one. Dispatch order:
//
//   1. Foreground before background. Background units wait while any
//      foreground unit is unfinished, including one backing off for a retry.
//   2. Within a class, the most recently requested units first. Every chapter
//      request (including each poll) re-stamps its units, so the chapter a
//      reader is looking at outranks one they have swiped away from.
//   3. Then submission order, so a chapter's verses render top to bottom.
//
// Failed units retry with exponential backoff unless the error says it is not
// retryable (err.retryable === false).

const FOREGROUND = 'foreground';
const BACKGROUND = 'background';

function createScheduler({ concurrency, retries = 2, retryBaseMs = 1000, onRetry = () => {} }) {
  const units = new Map();
  const queue = [];
  let running = 0;
  let foregroundUnits = 0;
  let clock = 0;
  let seq = 0;

  function outranks(a, b) {
    if (a.priority !== b.priority) return a.priority === FOREGROUND;
    if (a.touchedAt !== b.touchedAt) return a.touchedAt > b.touchedAt;
    return a.seq < b.seq;
  }

  function dispatch() {
    while (running < concurrency) {
      let best = -1;
      for (let i = 0; i < queue.length; i++) {
        const unit = queue[i];
        if (unit.priority === BACKGROUND && foregroundUnits > 0) continue;
        if (best === -1 || outranks(unit, queue[best])) best = i;
      }
      if (best === -1) return;
      const [unit] = queue.splice(best, 1);
      run(unit);
    }
  }

  function settle(unit, ok, value) {
    units.delete(unit.key);
    if (unit.priority === FOREGROUND) foregroundUnits--;
    if (ok) unit.resolve(value);
    else unit.reject(value);
  }

  async function run(unit) {
    running++;
    unit.attempts++;
    const startedAt = Date.now();
    const timing = () => ({
      attempts: unit.attempts,
      queueMs: startedAt - unit.queuedAt,
      apiMs: Date.now() - startedAt,
      totalMs: Date.now() - unit.submittedAt,
    });
    try {
      const result = await unit.task();
      settle(unit, true, { result, timing: timing() });
    } catch (err) {
      err.timing = timing();
      if (err.retryable !== false && unit.attempts <= retries) {
        const delayMs = retryBaseMs * 2 ** (unit.attempts - 1);
        onRetry(unit, err, delayMs);
        setTimeout(() => {
          unit.queuedAt = Date.now();
          queue.push(unit);
          dispatch();
        }, delayMs);
      } else {
        settle(unit, false, err);
      }
    } finally {
      running--;
      dispatch();
    }
  }

  // Raises a unit to foreground (never lowers it) and stamps it as touched.
  function refresh(unit, priority, touchedAt) {
    unit.touchedAt = touchedAt;
    if (priority === FOREGROUND && unit.priority !== FOREGROUND) {
      unit.priority = FOREGROUND;
      foregroundUnits++;
      return 'promoted';
    }
    return 'inflight';
  }

  // Marks the given units as most recently requested, all with one stamp so
  // they keep their order relative to each other. Returns 'promoted' if any
  // was raised to foreground, 'inflight' if any exists, otherwise null.
  function touch(keys, priority) {
    const touchedAt = ++clock;
    let status = null;
    for (const key of keys) {
      const unit = units.get(key);
      if (!unit) continue;
      if (refresh(unit, priority, touchedAt) === 'promoted') status = 'promoted';
      else status ??= 'inflight';
    }
    dispatch();
    return status;
  }

  // jobs: [{ key, task, meta }], submitted together as one request (one
  // touch stamp, then submission order). task: () => Promise. Each promise
  // resolves { result, timing } or rejects with the last error, carrying
  // err.timing. A key already known joins the existing unit
  // ('inflight' / 'promoted') instead of starting another ('started').
  function submit(jobs, priority = FOREGROUND) {
    const touchedAt = ++clock;
    const now = Date.now();
    const submitted = jobs.map(({ key, task, meta }) => {
      const existing = units.get(key);
      if (existing) return { status: refresh(existing, priority, touchedAt), promise: existing.promise };
      const unit = { key, task, meta, priority, touchedAt, seq: ++seq, attempts: 0, submittedAt: now, queuedAt: now };
      unit.promise = new Promise((resolve, reject) => { unit.resolve = resolve; unit.reject = reject; });
      units.set(key, unit);
      if (priority === FOREGROUND) foregroundUnits++;
      queue.push(unit);
      return { status: 'started', promise: unit.promise };
    });
    dispatch();
    return submitted;
  }

  return {
    submit,
    touch,
    stats: () => ({ running, queued: queue.length, units: units.size }),
  };
}

module.exports = { createScheduler, FOREGROUND, BACKGROUND };
