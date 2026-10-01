'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScheduler, BACKGROUND, FOREGROUND } = require('../src/render/scheduler');
const { sleep } = require('./helpers');

// A task that records when it starts and finishes after `ms`.
function recorder() {
  const started = [];
  let active = 0;
  let maxActive = 0;
  const task = (name, ms = 10, fail) => async () => {
    started.push(name);
    active++;
    maxActive = Math.max(maxActive, active);
    await sleep(ms);
    active--;
    if (fail) throw fail();
    return name;
  };
  return { started, task, get maxActive() { return maxActive; } };
}

const jobs = (r, names, ms) => names.map(name => ({ key: name, task: r.task(name, ms) }));
const settle = submitted => Promise.allSettled(submitted.map(s => s.promise));

test('never runs more than `concurrency` tasks at once', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 3 });
  await settle(scheduler.submit(jobs(r, ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 15)));
  assert.equal(r.started.length, 7);
  assert.equal(r.maxActive, 3);
});

test('a key already queued or running joins the existing unit', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 1 });
  const [first] = scheduler.submit([{ key: 'x', task: r.task('x', 20) }]);
  const [again] = scheduler.submit([{ key: 'x', task: r.task('x-duplicate') }]);
  assert.equal(first.status, 'started');
  assert.equal(again.status, 'inflight');
  assert.equal(again.promise, first.promise);
  assert.equal((await first.promise).result, 'x');
  assert.deepEqual(r.started, ['x']);
});

test('a batch runs in submission order; a newer request jumps ahead of an older one', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 1 });
  const older = scheduler.submit(jobs(r, ['old-1', 'old-2', 'old-3'], 10));
  const newer = scheduler.submit(jobs(r, ['new-1', 'new-2'], 10));
  await settle([...older, ...newer]);
  // old-1 was already running when the newer batch arrived.
  assert.deepEqual(r.started, ['old-1', 'new-1', 'new-2', 'old-2', 'old-3']);
});

test('touching an older batch (a reader polling it again) puts it back in front', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 1 });
  const a = scheduler.submit(jobs(r, ['a1', 'a2', 'a3'], 10));
  const b = scheduler.submit(jobs(r, ['b1', 'b2'], 10));
  assert.equal(scheduler.touch(['a2', 'a3', 'missing'], FOREGROUND), 'inflight');
  assert.equal(scheduler.touch(['missing'], FOREGROUND), null);
  await settle([...a, ...b]);
  assert.deepEqual(r.started, ['a1', 'a2', 'a3', 'b1', 'b2']);
});

test('background work uses free slots but leaves the reserve to foreground', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 4, reserve: 1 });
  const f1 = scheduler.submit(jobs(r, ['f1'], 40), FOREGROUND);
  const bg = scheduler.submit(jobs(r, ['b1', 'b2', 'b3'], 40), BACKGROUND);
  // Foreground work in flight no longer holds prefetches back, but b3 would
  // take the reserved slot.
  assert.deepEqual(r.started, ['f1', 'b1', 'b2']);
  assert.deepEqual(scheduler.stats(), { running: 3, queued: 1, units: 4 });
  // A chapter the reader opens now starts at once, in the reserve.
  const f2 = scheduler.submit(jobs(r, ['f2'], 5), FOREGROUND);
  assert.deepEqual(r.started, ['f1', 'b1', 'b2', 'f2']);
  await sleep(20);
  // f2 has finished, but three units still run, so b3 keeps waiting.
  assert.deepEqual(r.started, ['f1', 'b1', 'b2', 'f2']);
  await settle([...f1, ...bg, ...f2]);
  assert.deepEqual(r.started, ['f1', 'b1', 'b2', 'f2', 'b3']);
  assert.equal(r.maxActive, 4);
});

test('a background unit runs while foreground work backs off; queued foreground still goes first', async () => {
  const started = [];
  const scheduler = createScheduler({ concurrency: 2, reserve: 1, retries: 1, retryBaseMs: 30 });
  let failures = 1;
  const fg = scheduler.submit([{
    key: 'fg',
    task: async () => {
      started.push('fg');
      await sleep(5);
      if (failures-- > 0) throw new Error('transient');
    },
  }], FOREGROUND);
  const bg = scheduler.submit([
    { key: 'bg', task: async () => { started.push('bg'); await sleep(60); } },
    { key: 'bg-late', task: async () => { started.push('bg-late'); } },
  ], BACKGROUND);
  await settle([...fg, ...bg]);
  // bg starts as soon as fg's first attempt frees the only unreserved slot,
  // without waiting out fg's backoff; fg's retry runs in the reserve beside
  // it; bg-late waits for the unreserved slot.
  assert.deepEqual(started, ['fg', 'bg', 'fg', 'bg-late']);
});

test('the reserve defaults to a quarter of the slots, rounded down', async () => {
  for (const [concurrency, backgroundSlots] of [[1, 1], [2, 2], [4, 3], [32, 24]]) {
    const r = recorder();
    const scheduler = createScheduler({ concurrency });
    const names = Array.from({ length: concurrency + 1 }, (_, i) => `b${i}`);
    const bg = scheduler.submit(jobs(r, names, 5), BACKGROUND);
    assert.equal(r.started.length, backgroundSlots, String(concurrency));
    await settle(bg);
  }
});

test('touching a background unit with foreground priority promotes it', async () => {
  const r = recorder();
  const scheduler = createScheduler({ concurrency: 1 });
  const [blocker] = scheduler.submit(jobs(r, ['running'], 20), FOREGROUND);
  const bg = scheduler.submit(jobs(r, ['bg'], 5), BACKGROUND);
  const fg = scheduler.submit(jobs(r, ['fg'], 5), FOREGROUND);
  assert.equal(scheduler.touch(['bg'], FOREGROUND), 'promoted');
  await settle([blocker, ...bg, ...fg]);
  // Promoted with a newer stamp than fg, so it now goes first.
  assert.deepEqual(r.started, ['running', 'bg', 'fg']);
});

test('retries with backoff, then reports attempts in the timing', async () => {
  const retries = [];
  const scheduler = createScheduler({ concurrency: 1, retries: 2, retryBaseMs: 5, onRetry: (unit, err, delay) => retries.push(delay) });
  let calls = 0;
  const [unit] = scheduler.submit([{ key: 'k', task: async () => { if (++calls < 3) throw new Error('flaky'); return 'done'; } }]);
  const { result, timing } = await unit.promise;
  assert.equal(result, 'done');
  assert.equal(timing.attempts, 3);
  assert.deepEqual(retries, [5, 10]);
  assert.ok(timing.totalMs >= 15);
});

test('gives up after the last retry, and at once for non-retryable errors', async () => {
  const scheduler = createScheduler({ concurrency: 1, retries: 2, retryBaseMs: 1 });
  let calls = 0;
  const [exhausted] = scheduler.submit([{ key: 'a', task: async () => { calls++; throw new Error('always'); } }]);
  await assert.rejects(exhausted.promise, err => err.message === 'always' && err.timing.attempts === 3);
  assert.equal(calls, 3);

  let badCalls = 0;
  const [bad] = scheduler.submit([{ key: 'b', task: async () => { badCalls++; throw Object.assign(new Error('400'), { retryable: false }); } }]);
  await assert.rejects(bad.promise, /400/);
  assert.equal(badCalls, 1);
  assert.deepEqual(scheduler.stats(), { running: 0, queued: 0, units: 0 });
});
