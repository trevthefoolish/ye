'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { memoryLogger } = require('../src/log');
const { postJson } = require('../src/render/xai');
const { createVersePipeline } = require('../src/render/verse-v1');

const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const post = fetchImpl => postJson('http://xai.test', {}, { apiKey: 'k', timeoutMs: 1000, fetchImpl });

test('postJson classifies failures as retryable or not', async () => {
  await assert.rejects(post(reply(400, { error: { message: 'bad model' } })), err => err.message === 'xAI HTTP 400: bad model' && err.retryable === false && err.status === 400);
  await assert.rejects(post(reply(404, 'not json')), err => err.message === 'xAI HTTP 404' && err.retryable === false);
  for (const status of [408, 409, 429, 500, 503]) {
    await assert.rejects(post(reply(status, {})), err => err.retryable === true, String(status));
  }
  await assert.rejects(post(async () => { throw new TypeError('socket hang up'); }), err => err.retryable && /request failed: socket hang up/.test(err.message));
  await assert.rejects(post(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), /timed out after 1000ms/);
  await assert.rejects(post(reply(200, '<html>')), /non-JSON/);
  assert.deepEqual(await post(reply(200, { ok: 1 })), { ok: 1 });
});

test('verse-v1 sends the reference, cleans the text, and flags long notes', async () => {
  const log = memoryLogger();
  let sent;
  const content = JSON.stringify({ rendering: 'Vapor of vapors—all is vapor.', note: 'A note that runs longer than its verse does.' });
  const pipeline = createVersePipeline({
    apiUrl: 'http://xai.test', apiKey: 'k', model: 'grok-4.5', reasoningEffort: 'low', verseTimeoutMs: 1000, log,
    fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [{ message: { content } }] })); },
  });
  const [unit] = pipeline.plan({ bookIndex: 20, book: 'Ecclesiastes', chapter: 1 }, [2]);
  assert.equal(unit.key, 'verse:20:1:2');
  const [entry] = await unit.render();
  assert.deepEqual(entry, { bookIndex: 20, chapter: 1, verse: 2, rendering: 'Vapour of vapours, all is vapour.', note: 'A note that runs longer than its verse does.' });
  assert.equal(sent.messages[1].content, 'Ecclesiastes 1:2');
  assert.equal(sent.reasoning_effort, 'low');
  assert.ok(log.entries.some(e => e.event === 'note_too_long' && e.verse === 2));
});

test('verse-v1 rejects malformed structured output', async () => {
  const pipeline = createVersePipeline({
    apiUrl: 'http://xai.test', apiKey: 'k', model: 'm', reasoningEffort: 'low', verseTimeoutMs: 1000, log: memoryLogger(),
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"rendering": 1}' } }] })),
  });
  const [unit] = pipeline.plan({ bookIndex: 0, book: 'Genesis', chapter: 1 }, [1]);
  await assert.rejects(unit.render(), /malformed verse rendering/);
});
