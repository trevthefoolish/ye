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

test('background work waits until no foreground work is left, including retries', async () => {
  const started = [];
  const scheduler = createScheduler({ concurrency: 2, retries: 1, retryBaseMs: 30 });
  let failures = 1;
  const fg = scheduler.submit([{
    key: 'fg',
    task: async () => {
      started.push('fg');
      await sleep(5);
      if (failures-- > 0) throw new Error('transient');
    },
  }], FOREGROUND);
  const bg = scheduler.submit([{ key: 'bg', task: async () => { started.push('bg'); } }], BACKGROUND);
  await settle([...fg, ...bg]);
  // A slot is free the whole time, and during fg's 30 ms backoff nothing is
  // running at all, but bg still waits for fg to finish.
  assert.deepEqual(started, ['fg', 'fg', 'bg']);
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
