// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Minimal xAI Responses API client. Calls stream (server-sent events), so a
// caller can use the output text while the model is still writing it.

class RenderError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.name = 'RenderError';
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

// Client errors will fail the same way again; rate limits and server errors may
// not, and neither may a failure that names no status.
const RETRYABLE_STATUS = new Set([408, 409, 429]);
const retryableStatus = status => !Number.isInteger(status) || status >= 500 || RETRYABLE_STATUS.has(status);

// A failure to reach xAI or to read its stream; may succeed next time.
function transportError(err, timeoutMs) {
  if (err instanceof RenderError) return err;
  return new RenderError(err?.name === 'TimeoutError' ? `xAI request timed out after ${timeoutMs}ms` : `xAI request failed: ${err?.message}`);
}

// POSTs `body` and resolves the response once its status is OK; an error
// status throws, classified as retryable or not. `signal` also bounds reading
// the response body.
async function post(url, body, { apiKey, signal, timeoutMs, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw transportError(err, timeoutMs);
  }
  if (!res.ok) {
    let message = `xAI HTTP ${res.status}`;
    try {
      // xAI sends { code, error: "..." }; accept the { error: { message } } shape too.
      const data = await res.json();
      const detail = typeof data?.error === 'string' ? data.error : data?.error?.message;
      if (detail) message += `: ${detail}`;
      else if (typeof data?.code === 'string') message += `: ${data.code}`;
    } catch { /* non-JSON error body; the status is enough */ }
    throw new RenderError(message, { status: res.status, retryable: retryableStatus(res.status) });
  }
  return res;
}

// The data of each server-sent event in `body`, as a string. xAI sends
// data-only events ending with "data: [DONE]"; comments and other fields
// ("event:", "id:") are skipped, since every Responses API event names its own
// type in its data.
async function* eventData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const line = raw => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (text === '') {
      if (data.length === 0) return null;
      const event = data.join('\n');
      data = [];
      return event;
    }
    if (text.startsWith('data:')) data.push(text.slice(text.startsWith('data: ') ? 6 : 5));
    return null;
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const raw of lines) {
      const event = line(raw);
      if (event !== null) yield event;
    }
  }
  // A stream that ends without a final blank line still delivers its last event.
  for (const raw of [buffer + decoder.decode(), '']) {
    const event = line(raw);
    if (event !== null) yield event;
  }
}

// The assistant's text in a Responses API result. Reasoning models also return
// reasoning items, so the message is not necessarily output[0].
function outputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== 'message') continue;
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text;
    }
  }
  return null;
}

// Billed token counts, summed across calls (reasoning tokens bill as output).
const emptyUsage = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0 });

function addUsage(total, usage) {
  if (!total || !usage) return;
  total.inputTokens += usage.input_tokens || 0;
  total.cachedTokens += usage.input_tokens_details?.cached_tokens || 0;
  total.outputTokens += usage.output_tokens || 0;
  total.reasoningTokens += usage.output_tokens_details?.reasoning_tokens || 0;
}

// Error codes inside a stream that will fail the same way again.
const FINAL_CODES = new Set(['invalid_request_error', 'invalid_api_key', 'insufficient_quota']);

// A response.failed or response.incomplete event, or an error event (which xAI
// can send after the HTTP 200, e.g. for invalid arguments), as a RenderError.
// Retryable unless its status or code says it will fail again.
function streamFailure(event) {
  const error = event.response?.error ?? event.error;
  const detail = error?.message
    || event.response?.incomplete_details?.reason
    || event.message
    || (typeof error === 'string' ? error : null)
    || event.code;
  const what = event.type === 'response.incomplete' ? 'xAI response incomplete' : 'xAI response failed';
  const status = event.status ?? error?.status;
  const code = event.code ?? error?.code;
  return new RenderError(detail ? `${what}: ${detail}` : what, { status, retryable: retryableStatus(status) && !FINAL_CODES.has(code) });
}

// Follows a Responses API event stream to the end of the response. Calls
// onText with the output text so far each time it grows, adds the billed
// usage, and resolves the final text (null if there is none). Reasoning and
// other events are ignored; the text is that of the first output text part,
// since xAI can interleave other output items with it.
async function readResponse(body, { usage, onText, timeoutMs }) {
  let text = '';
  let part = null;
  try {
    for await (const data of eventData(body)) {
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue; // not an event (e.g. the "[DONE]" sentinel)
      }
      switch (event?.type) {
        case 'response.output_text.delta': {
          if (typeof event.delta !== 'string' || event.delta === '') break;
          const key = `${event.item_id}:${event.content_index}`;
          part ??= key;
          if (key !== part) break;
          text += event.delta;
          onText?.(text);
          break;
        }
        case 'response.completed':
        case 'response.done': // an alias some clients accept for the same event
          addUsage(usage, event.response?.usage);
          return outputText(event.response) ?? (text || null);
        case 'response.failed':
        case 'response.incomplete':
          addUsage(usage, event.response?.usage);
          throw streamFailure(event);
        case 'error':
          throw streamFailure(event);
      }
    }
  } catch (err) {
    throw transportError(err, timeoutMs);
  }
  throw new RenderError('xAI stream ended before the response completed');
}

// One streamed Responses API call with strict JSON-schema output; resolves the
// parsed object and adds the call's token counts to `usage` when given.
// `onText`, if given, sees the output text so far each time more arrives.
// Nothing is stored server-side (store: false).
async function requestStructured({ apiUrl, apiKey, model, reasoningEffort, systemPrompt, user, schemaName, schema, timeoutMs, fetchImpl, usage, onText }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const res = await post(apiUrl, {
    model,
    reasoning: { effort: reasoningEffort },
    store: false,
    stream: true,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
  }, { apiKey, signal, timeoutMs, fetchImpl });
  if (!res.body) throw new RenderError('xAI returned an empty body');
  const raw = await readResponse(res.body, { usage, onText, timeoutMs });
  if (typeof raw !== 'string') throw new RenderError('unexpected Responses API shape');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RenderError('malformed JSON from Responses API');
  }
}

module.exports = { RenderError, emptyUsage, eventData, post, requestStructured };
