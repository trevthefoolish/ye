// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Minimal xAI HTTP client shared by both render pipelines.

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
      const data = await res.json();
      if (data?.error?.message) message += `: ${data.error.message}`;
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

// Structured output arrives as a JSON string inside the API envelope.
function parseStructured(raw, what) {
  if (typeof raw !== 'string') throw new RenderError(`unexpected ${what} response shape`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new RenderError(`malformed JSON from ${what}`);
  }
}

module.exports = { RenderError, parseStructured, postJson };
