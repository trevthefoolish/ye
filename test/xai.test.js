'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyUsage, postJson, requestStructured } = require('../src/render/xai');

const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const post = fetchImpl => postJson('http://xai.test', {}, { apiKey: 'k', timeoutMs: 1000, fetchImpl });
// A Responses API body the way grok-4.7 returns it: reasoning first, then the message.
const responsesBody = text => ({
  output: [
    { type: 'reasoning', summary: [], encrypted_content: 'opaque' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  ],
});

test('postJson classifies failures as retryable or not', async () => {
  // xAI's error body: { code, error: "<text>" }.
  await assert.rejects(post(reply(400, { code: 'Client specified an invalid argument', error: 'Argument not supported: reasoning.effort' })),
    err => err.message === 'xAI HTTP 400: Argument not supported: reasoning.effort' && err.retryable === false && err.status === 400);
  await assert.rejects(post(reply(400, { error: { message: 'bad model' } })), err => err.message === 'xAI HTTP 400: bad model');
  await assert.rejects(post(reply(403, { code: 'Forbidden' })), err => err.message === 'xAI HTTP 403: Forbidden');
  await assert.rejects(post(reply(404, 'not json')), err => err.message === 'xAI HTTP 404' && err.retryable === false);
  for (const status of [408, 409, 429, 500, 503]) {
    await assert.rejects(post(reply(status, {})), err => err.retryable === true, String(status));
  }
  await assert.rejects(post(async () => { throw new TypeError('socket hang up'); }), err => err.retryable && /request failed: socket hang up/.test(err.message));
  await assert.rejects(post(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), /timed out after 1000ms/);
  await assert.rejects(post(reply(200, '<html>')), /non-JSON/);
  assert.deepEqual(await post(reply(200, { ok: 1 })), { ok: 1 });
});

test('requestStructured sends a strict-schema Responses request and parses the message text', async () => {
  let sent;
  const parsed = await requestStructured({
    apiUrl: 'http://xai.test', apiKey: 'k', model: 'grok-4.7', reasoningEffort: 'low', timeoutMs: 1000,
    systemPrompt: 'system', user: 'Ruth 1:1', schemaName: 'verse_rendering', schema: { type: 'object' },
    fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify(responsesBody('{"ok":true}'))); },
  });
  assert.deepEqual(parsed, { ok: true });
  assert.equal(sent.url, 'http://xai.test');
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(sent.init.body), {
    model: 'grok-4.7',
    reasoning: { effort: 'low' },
    store: false,
    input: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Ruth 1:1' }],
    text: { format: { type: 'json_schema', name: 'verse_rendering', strict: true, schema: { type: 'object' } } },
  });

  const call = (body, usage) => requestStructured({ apiUrl: 'x', apiKey: 'k', timeoutMs: 1000, usage, fetchImpl: async () => new Response(JSON.stringify(body)) });
  await assert.rejects(call({ output: [{ type: 'reasoning' }] }), /unexpected Responses API shape/);
  await assert.rejects(call(responsesBody('not json')), /malformed JSON/);

  // Token counts add up across calls, including a billed call whose output is unusable.
  const usage = emptyUsage();
  const billed = { input_tokens: 700, input_tokens_details: { cached_tokens: 600 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 } };
  await call({ ...responsesBody('{}'), usage: billed }, usage);
  await assert.rejects(call({ ...responsesBody('not json'), usage: billed }, usage));
  await call(responsesBody('{}'), usage); // no usage reported
  assert.deepEqual(usage, { inputTokens: 1400, cachedTokens: 1200, outputTokens: 600, reasoningTokens: 500 });
});
