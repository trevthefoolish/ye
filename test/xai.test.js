'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { emptyUsage, eventData, post, requestStructured } = require('../src/render/xai');
const { sseResponse, sseStream } = require('./helpers');

const reply = (status, body) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const postTo = fetchImpl => post('http://xai.test', {}, { apiKey: 'k', timeoutMs: 1000, fetchImpl });

// A response the way grok-4.7 streams it: reasoning first, then the message
// text in deltas, then the completed response with usage.
const message = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const reasoning = { type: 'reasoning', summary: [], encrypted_content: 'opaque' };
const deltas = (text, size = 4) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => ({ type: 'response.output_text.delta', delta: text.slice(i * size, (i + 1) * size) }));
const streamed = (text, usage) => [
  { type: 'response.created', response: { status: 'in_progress', output: [] } },
  { type: 'response.output_item.added', output_index: 0, item: reasoning },
  ...deltas(text),
  { type: 'response.output_text.done', text },
  { type: 'response.completed', response: { status: 'completed', output: [reasoning, message(text)], ...(usage && { usage }) } },
];
const call = (events, extra = {}) => requestStructured({ apiUrl: 'x', apiKey: 'k', timeoutMs: 1000, fetchImpl: async () => sseResponse(events), ...extra });

test('post classifies failures as retryable or not', async () => {
  // xAI's error body: { code, error: "<text>" }.
  await assert.rejects(postTo(reply(400, { code: 'Client specified an invalid argument', error: 'Argument not supported: reasoning.effort' })),
    err => err.message === 'xAI HTTP 400: Argument not supported: reasoning.effort' && err.retryable === false && err.status === 400);
  await assert.rejects(postTo(reply(400, { error: { message: 'bad model' } })), err => err.message === 'xAI HTTP 400: bad model');
  await assert.rejects(postTo(reply(403, { code: 'Forbidden' })), err => err.message === 'xAI HTTP 403: Forbidden');
  await assert.rejects(postTo(reply(404, 'not json')), err => err.message === 'xAI HTTP 404' && err.retryable === false);
  for (const status of [408, 409, 429, 500, 503]) {
    await assert.rejects(postTo(reply(status, {})), err => err.retryable === true, String(status));
  }
  await assert.rejects(postTo(async () => { throw new TypeError('socket hang up'); }), err => err.retryable && /request failed: socket hang up/.test(err.message));
  await assert.rejects(postTo(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }), /timed out after 1000ms/);
  assert.equal((await postTo(reply(200, { ok: 1 }))).status, 200);
});

test('eventData reads server-sent events however the bytes are split', async () => {
  const raw = [
    ': keep-alive\r\n\r\n',
    'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\n',
    'id: 7\ndata:{"type":"a","text":"vapour — ünïcödé ✓"}\n\n',
    'data: {"type":"b",\ndata: "two":"lines"}\n\n',
    'data: [DONE]\n\n',
    'data: {"type":"last"}',
  ].join('');
  const expected = ['{"type":"response.created"}', '{"type":"a","text":"vapour — ünïcödé ✓"}', '{"type":"b",\n"two":"lines"}', '[DONE]', '{"type":"last"}'];
  for (const chunkSize of [1, 2, 3, 7, 1000]) {
    const seen = [];
    for await (const data of eventData(sseResponse([raw], { chunkSize }).body)) seen.push(data);
    assert.deepEqual(seen, expected, `chunks of ${chunkSize}`);
  }
});

test('requestStructured streams a strict-schema Responses request and parses the final text', async () => {
  let sent;
  const texts = [];
  const text = '{"verses":[{"verse":1}]}';
  const parsed = await requestStructured({
    apiUrl: 'http://xai.test', apiKey: 'k', model: 'grok-4.7', reasoningEffort: 'low', timeoutMs: 1000,
    systemPrompt: 'system', user: 'Ruth 1:1-8', schemaName: 'passage_rendering', schema: { type: 'object' },
    onText: so => texts.push(so),
    fetchImpl: async (url, init) => { sent = { url, init }; return sseResponse(streamed(text)); },
  });
  assert.deepEqual(parsed, { verses: [{ verse: 1 }] });
  assert.equal(sent.url, 'http://xai.test');
  assert.equal(sent.init.headers.Authorization, 'Bearer k');
  assert.ok(sent.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(sent.init.body), {
    model: 'grok-4.7',
    reasoning: { effort: 'low' },
    store: false,
    stream: true,
    input: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Ruth 1:1-8' }],
    text: { format: { type: 'json_schema', name: 'passage_rendering', strict: true, schema: { type: 'object' } } },
  });
  // onText sees the text so far each time a delta arrives.
  assert.equal(texts.length, Math.ceil(text.length / 4));
  texts.forEach((so, i) => assert.equal(so, text.slice(0, (i + 1) * 4)));
});

test('requestStructured hands over text while the response is still streaming', async () => {
  const stream = sseStream();
  const texts = [];
  const result = requestStructured({ apiUrl: 'x', apiKey: 'k', timeoutMs: 1000, onText: so => texts.push(so), fetchImpl: async () => stream.response });
  stream.push({ type: 'response.output_text.delta', delta: '{"a":' });
  stream.push({ type: 'response.output_text.delta', delta: '1}' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(texts, ['{"a":', '{"a":1}']);
  stream.push({ type: 'response.completed', response: { output: [message('{"a":1}')] } });
  stream.end();
  assert.deepEqual(await result, { a: 1 });
});

test('requestStructured reads a stream framed the way xAI documents it', async () => {
  // Data-only events with sequence numbers, reasoning summary events before
  // the message, content parts, and a closing [DONE].
  const text = '{"verses":[{"verse":1,"rendering":"In the beginning","note":"n"}]}';
  const msg = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, logprobs: [], annotations: [] }] };
  const rs = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'First' }], status: 'completed', encrypted_content: 'x'.repeat(30_000) };
  const events = [
    { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [], usage: null } },
    { type: 'response.in_progress', response: { id: 'r', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [], status: 'in_progress' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'First' },
    { type: 'response.reasoning_text.delta', item_id: 'rs_1', output_index: 0, content_index: 0, delta: 'Thinking' },
    { type: 'response.output_item.done', output_index: 0, item: rs },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(0, 30), logprobs: [] },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 1, content_index: 0, delta: text.slice(30), logprobs: [] },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 1, content_index: 0, text },
    { type: 'response.content_part.done', item_id: 'msg_1', output_index: 1, content_index: 0, part: { type: 'output_text', text } },
    { type: 'response.output_item.done', output_index: 1, item: msg },
    { type: 'response.completed', response: { id: 'r', status: 'completed', output: [rs, msg], usage: { input_tokens: 216, input_tokens_details: { cached_tokens: 192 }, output_tokens: 923, output_tokens_details: { reasoning_tokens: 323 }, total_tokens: 1139, num_sources_used: 0 } } },
  ].map((event, i) => `data: ${JSON.stringify({ sequence_number: i, ...event })}\n\n`);
  const usage = emptyUsage();
  const texts = [];
  const parsed = await call([...events, 'data: [DONE]\n\n'], { usage, onText: so => texts.push(so) });
  assert.deepEqual(parsed, JSON.parse(text));
  assert.deepEqual(texts, [text.slice(0, 30), text]);
  assert.deepEqual(usage, { inputTokens: 216, cachedTokens: 192, outputTokens: 923, reasoningTokens: 323 });
});

test('only the first output text part is the text, and response.done also ends a response', async () => {
  const texts = [];
  const events = [
    { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: '{"a":' },
    { type: 'response.output_text.delta', item_id: 'msg_2', content_index: 0, delta: 'other item' },
    { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 1, delta: 'other part' },
    { type: 'response.output_text.delta', item_id: 'msg_1', content_index: 0, delta: '3}' },
    { type: 'response.done', response: { status: 'completed' } },
  ];
  assert.deepEqual(await call(events, { onText: so => texts.push(so) }), { a: 3 });
  assert.deepEqual(texts, ['{"a":', '{"a":3}']);
});

test('requestStructured fails on failed, incomplete, broken, or unusable responses', async () => {
  const failed = { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'overloaded' } } };
  await assert.rejects(call([...deltas('{"ver'), failed]), err => err.message === 'xAI response failed: overloaded' && err.retryable === true);
  const incomplete = { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } };
  await assert.rejects(call([incomplete]), err => err.message === 'xAI response incomplete: max_output_tokens' && err.retryable);
  await assert.rejects(call([{ type: 'error', code: 'internal', error: 'boom' }]), /xAI response failed: boom/);
  await assert.rejects(call([{ type: 'response.completed', response: { output: [reasoning] } }]), /unexpected Responses API shape/);
  await assert.rejects(call(streamed('not json')), /malformed JSON/);
  await assert.rejects(requestStructured({ apiUrl: 'x', apiKey: 'k', timeoutMs: 1000, fetchImpl: async () => new Response(null) }), /empty body/);

  const broken = sseStream();
  const pending = requestStructured({ apiUrl: 'x', apiKey: 'k', timeoutMs: 1000, fetchImpl: async () => broken.response });
  broken.push({ type: 'response.output_text.delta', delta: '{' });
  broken.fail(new TypeError('terminated'));
  await assert.rejects(pending, err => err.message === 'xAI request failed: terminated' && err.retryable);
});

test('an error inside the stream is retried only if it may not recur', async () => {
  const created = { type: 'response.created', response: { status: 'in_progress', output: [] } };
  // Before the response starts, an error is the request being refused, the
  // way xAI reports invalid arguments after a 200.
  const invalid = { type: 'error', sequence_number: 0, code: null, message: 'Invalid arguments passed to the model.', param: null };
  await assert.rejects(call([invalid, 'data: [DONE]\n\n']), err => err.message === 'xAI response failed: Invalid arguments passed to the model.' && err.retryable === false);
  // Once it has started, a failure may not happen again.
  await assert.rejects(call([created, ...deltas('{"a"'), { type: 'error', code: null, message: 'stream reset' }]), err => err.retryable === true);
  // A status or a known code decides either way.
  await assert.rejects(call([{ type: 'error', status: 400, error: { code: 'invalid_argument', message: 'bad schema' } }]),
    err => err.message === 'xAI response failed: bad schema' && err.retryable === false && err.status === 400);
  await assert.rejects(call([created, { type: 'error', status: 400, error: { message: 'bad' } }]), err => err.retryable === false);
  await assert.rejects(call([{ type: 'error', status: 429, error: { code: 'rate_limit_exceeded', message: 'later' } }]), err => err.retryable && err.status === 429);
  for (const code of ['rate_limit_exceeded', 'server_error', 'overloaded_error', 'service_unavailable']) {
    await assert.rejects(call([{ type: 'error', code, message: 'later' }]), err => err.retryable === true, code);
  }
  for (const code of ['invalid_request_error', 'invalid_api_key', 'insufficient_quota']) {
    await assert.rejects(call([created, { type: 'error', code, message: 'no' }]), err => err.retryable === false, code);
    await assert.rejects(call([{ type: 'response.failed', response: { error: { code, message: 'no' } } }]), err => err.retryable === false, code);
  }
});

test('a stream that ends without a final event counts only if its text is whole', async () => {
  assert.deepEqual(await call([...deltas('{"a":1}'), 'data: [DONE]\n\n']), { a: 1 });
  assert.deepEqual(await call(deltas('{"a":1}')), { a: 1 });
  const ended = err => err.message === 'xAI stream ended before the response completed' && err.retryable;
  await assert.rejects(call(deltas('{"a":1')), ended);
  await assert.rejects(call([]), ended);
  // Nothing after [DONE] is read.
  await assert.rejects(call([...deltas('{"a":'), 'data: [DONE]\n\n', ...deltas('1}')]), ended);
});

test('a reply that comes back whole instead of streaming is read whole', async () => {
  const usage = emptyUsage();
  const texts = [];
  const json = body => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const body = { output: [reasoning, message('{"a":5}')], usage: { input_tokens: 10, output_tokens: 20 } };
  assert.deepEqual(await call([], { usage, onText: so => texts.push(so), fetchImpl: json(body) }), { a: 5 });
  assert.deepEqual(usage, { inputTokens: 10, cachedTokens: 0, outputTokens: 20, reasoningTokens: 0 });
  assert.deepEqual(texts, []);
  await assert.rejects(call([], { fetchImpl: json('<html>') }), /non-JSON body/);
  await assert.rejects(call([], { fetchImpl: json({ output: [reasoning] }) }), /unexpected Responses API shape/);
});

test('without a final message item, the streamed text is the result', async () => {
  const events = [...deltas('{"a":2}'), { type: 'response.completed', response: { status: 'completed' } }];
  assert.deepEqual(await call(events), { a: 2 });
});

test('token counts add up across calls, including billed calls that failed', async () => {
  const usage = emptyUsage();
  const billed = { input_tokens: 700, input_tokens_details: { cached_tokens: 600 }, output_tokens: 300, output_tokens_details: { reasoning_tokens: 250 } };
  await call(streamed('{}', billed), { usage });
  await assert.rejects(call(streamed('not json', billed), { usage }));
  await assert.rejects(call([{ type: 'response.failed', response: { error: { message: 'x' }, usage: billed } }], { usage }));
  await call(streamed('{}'), { usage }); // no usage reported
  assert.deepEqual(usage, { inputTokens: 2100, cachedTokens: 1800, outputTokens: 900, reasoningTokens: 750 });
});

test('the timeout also bounds a stream that stalls after it starts', { timeout: 10_000 }, async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/warm') return res.end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"type":"response.output_text.delta","delta":"{"}\n\n');
    // ...and nothing more.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await (await fetch(`${base}/warm`)).text(); // fetch's first use is slow; keep it out of the timing
  const texts = [];
  const started = Date.now();
  await assert.rejects(
    requestStructured({ apiUrl: `${base}/`, apiKey: 'k', timeoutMs: 500, onText: so => texts.push(so) }),
    err => err.message === 'xAI request timed out after 500ms' && err.retryable,
  );
  assert.deepEqual(texts, ['{']);
  assert.ok(Date.now() - started < 5000);
});
