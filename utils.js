// Copyright (c) 2026 vapourware.ai All rights reserved.

// Shared helpers used by the server, renderer, and scripts. cleanText carries
// two load-bearing invariants: no em dashes, and "vapour" never "vapor".

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value || '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function cleanText(s) {
  return s
    .replaceAll('\u2014', ', ')
    .replace(/\bvapors\b/gi, 'vapours')
    .replace(/\bvapor\b/gi, 'vapour');
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');
}

module.exports = { parsePositiveInt, cleanText, escapeHtml, slugify };
