// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Minimal xAI Responses API client.

class RenderError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.name = 'RenderError';
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
  }
}

// Client errors will fail the same way again; rate limits and server errors may not.
const RETRYABLE_STATUS = new Set([408, 409, 429]);

async function postJson(url, body, { apiKey, timeoutMs, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new RenderError(err.name === 'TimeoutError' ? `xAI request timed out after ${timeoutMs}ms` : `xAI request failed: ${err.message}`);
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
    throw new RenderError(message, {
      status: res.status,
      retryable: res.status >= 500 || RETRYABLE_STATUS.has(res.status),
    });
  }
  try {
    return await res.json();
  } catch {
    throw new RenderError('xAI returned a non-JSON body');
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

// One Responses API call with strict JSON-schema output; resolves the parsed
// object and adds the call's token counts to `usage` when given. Nothing is
// stored server-side (store: false).
async function requestStructured({ apiUrl, apiKey, model, reasoningEffort, systemPrompt, user, schemaName, schema, timeoutMs, fetchImpl, usage }) {
  const data = await postJson(apiUrl, {
    model,
    reasoning: { effort: reasoningEffort },
    store: false,
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user },
    ],
    text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } },
  }, { apiKey, timeoutMs, fetchImpl });
  addUsage(usage, data?.usage);
  const raw = outputText(data);
  if (typeof raw !== 'string') throw new RenderError('unexpected Responses API shape');
  try {
    return JSON.parse(raw);
  } catch {
    throw new RenderError('malformed JSON from Responses API');
  }
}

module.exports = { RenderError, emptyUsage, postJson, requestStructured };
