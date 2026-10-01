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

// The data of each server-sent event in `body`, as a string. xAI sends an
// "event:" line and a "data:" line per event (its docs describe data-only
// events ending with "data: [DONE]"; both are read). Comments and fields other
// than data are skipped, since every Responses API event names its own type in
// its data.
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
// unreportedCalls counts calls accepted without a usage report, so their
// tokens are missing from the sums.
const emptyUsage = () => ({ inputTokens: 0, cachedTokens: 0, outputTokens: 0, reasoningTokens: 0, unreportedCalls: 0 });

function addUsage(total, usage) {
  if (!total || !usage) return;
  total.inputTokens += usage.input_tokens || 0;
  total.cachedTokens += usage.input_tokens_details?.cached_tokens || 0;
  total.outputTokens += usage.output_tokens || 0;
  total.reasoningTokens += usage.output_tokens_details?.reasoning_tokens || 0;
}

// Error codes that will fail the same way again, and ones that may not.
const FINAL_CODES = new Set(['invalid_request_error', 'invalid_api_key', 'insufficient_quota']);
const RETRYABLE_CODES = new Set(['rate_limit_exceeded', 'rate_limit_error', 'server_error', 'api_error', 'overloaded_error', 'service_unavailable', '529']);

// A response.failed or response.incomplete event, or an error event, as a
// RenderError. A status or a known code says whether it may succeed next
// time. Failing that, it depends on when it came: an error before the
// response started is the request being refused, as an HTTP 400 would be
// (xAI reports invalid arguments this way after a 200), while a failure once
// the model has started may not recur.
function streamFailure(event, started) {
  const error = event.response?.error ?? event.error;
  const detail = error?.message
    || event.response?.incomplete_details?.reason
    || event.message
    || (typeof error === 'string' ? error : null)
    || event.code;
  const what = event.type === 'response.incomplete' ? 'xAI response incomplete' : 'xAI response failed';
  const status = Number(event.status ?? error?.status) || undefined;
  const code = String(event.code ?? error?.code);
  const retryable = Number.isInteger(status) ? retryableStatus(status)
    : RETRYABLE_CODES.has(code) || /overload/i.test(detail || '') ? true
      : FINAL_CODES.has(code) ? false
        : started;
  return new RenderError(detail ? `${what}: ${detail}` : what, { status, retryable });
}

const isJson = text => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// Follows a Responses API event stream to the end of the response. Calls
// onText with the output text so far each time it grows, adds the billed
// usage, and resolves the final text (null if there is none). Reasoning and
// other events are ignored; the text is that of the first output text part,
// since xAI can interleave other output items with it.
async function readResponse(body, { usage, onText, timeoutMs }) {
  let text = '';
  let part = null;
  let started = false;
  try {
    for await (const data of eventData(body)) {
      if (data === '[DONE]') break;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue; // not an event
      }
      if (typeof event?.type !== 'string') continue;
      started ||= event.type.startsWith('response.');
      switch (event.type) {
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
          throw streamFailure(event, started);
        case 'error':
          throw streamFailure(event, started);
      }
    }
  } catch (err) {
    throw transportError(err, timeoutMs);
  }
  // The stream ended ("data: [DONE]", or the body closed) without saying how
  // the response ended. Its text still counts if it is whole: text cut off
  // partway never parses as JSON. Its usage was never reported.
  if (text && isJson(text)) {
    if (usage) usage.unreportedCalls++;
    return text;
  }
  throw new RenderError('xAI stream ended before the response completed');
}

// The final text of a plain JSON Responses API body, for a reply that did not
// stream after all. A failed or incomplete response, or a bare error body,
// fails the way the same thing would inside a stream.
async function readWhole(res, { usage, timeoutMs }) {
  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw err instanceof SyntaxError ? new RenderError('xAI returned a non-JSON body') : transportError(err, timeoutMs);
  }
  addUsage(usage, data?.usage);
  if (data?.status === 'failed' || data?.status === 'incomplete') throw streamFailure({ type: `response.${data.status}`, response: data }, true);
  if (data?.error) throw streamFailure({ ...data, type: 'error' }, false);
  if (usage && !data?.usage) usage.unreportedCalls++;
  return outputText(data);
}

// One streamed Responses API call with strict JSON-schema output; resolves the
// parsed object and adds the call's token counts to `usage` when given.
// `onText`, if given, sees the output text so far each time more arrives (a
// reply that comes back whole, unstreamed, is read whole without it).
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
  let raw;
  if (/^application\/([\w.+-]+\+)?json\b/i.test(res.headers.get('content-type') || '')) {
    raw = await readWhole(res, { usage, timeoutMs });
  } else {
    if (!res.body) throw new RenderError('xAI returned an empty body');
    raw = await readResponse(res.body, { usage, onText, timeoutMs });
  }
  if (typeof raw !== 'string') throw new RenderError('unexpected Responses API shape');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RenderError('malformed JSON from Responses API');
  }
}

module.exports = { RenderError, emptyUsage, eventData, post, requestStructured };
