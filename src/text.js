// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Text helpers shared by the server, renderers, and scripts.

const crypto = require('node:crypto');

// Load-bearing house style for every model-generated string: no em dashes,
// and always "vapour", never "vapor" (it is the project's name). Case is
// kept, so a sentence can still begin "Vapour of vapours".
function cleanText(s) {
  return s
    .replaceAll('—', ', ')
    .replace(/\b(vapo)(r)(s?)\b/gi, (match, stem, r, plural) => stem + (r === 'R' ? 'UR' : 'ur') + plural);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"'`]/g, ch => HTML_ESCAPES[ch]);
}

// JSON that is safe to place inside a <script> element: escaping every "<"
// rules out both "</script>" and "<!--" breaking out of the script block.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sha256(input, length = 64) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, length);
}

// JSON with object keys sorted, so equal values always serialize (and hash) the same.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// The cache key stamped on every render: a short hash of everything that
// shapes the model's output (pipeline, model, effort, prompt, schema, ...).
function renderVersion(parts) {
  return sha256(stableStringify(parts), 12);
}

module.exports = { cleanText, escapeHtml, jsonForScript, parsePositiveInt, renderVersion, slugify, sha256, stableStringify };
