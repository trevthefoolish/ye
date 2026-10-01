// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Builds the single-page shell once at startup: client/style.css is inlined,
// client/app.js is minified and served under a content-hashed URL, and
// client/index.html is compiled into a render function.
//
// Template syntax: {{name}} is HTML-escaped, {{{name}}} is inserted raw.

const fs = require('node:fs');
const path = require('node:path');
const { minify } = require('terser');
const { escapeHtml, jsonForScript, sha256 } = require('../text');

const PLACEHOLDER = /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

// Static values are baked in at compile time; the rest are filled per render.
function compileTemplate(source, statics = {}) {
  const segments = [];
  const pushText = text => {
    if (typeof segments[segments.length - 1] === 'string') segments[segments.length - 1] += text;
    else segments.push(text);
  };
  let last = 0;
  for (const match of source.matchAll(PLACEHOLDER)) {
    pushText(source.slice(last, match.index));
    last = match.index + match[0].length;
    const raw = match[1] !== undefined;
    const name = match[1] ?? match[2];
    if (Object.hasOwn(statics, name)) pushText(raw ? String(statics[name]) : escapeHtml(statics[name]));
    else segments.push({ name, raw });
  }
  pushText(source.slice(last));
  return vars => segments.map(s => {
    if (typeof s === 'string') return s;
    const value = vars[s.name] ?? '';
    return s.raw ? value : escapeHtml(value);
  }).join('');
}

async function minifyScript(source, log) {
  try {
    const { code } = await minify(source, { compress: true, mangle: true, format: { comments: /copyright/i } });
    if (code) {
      log.info('js_minified', { from: source.length, to: code.length });
      return code;
    }
  } catch (err) {
    log.warn('minify_failed', { err: err.message });
  }
  return source;
}

async function buildShell({ clientDir, clientConfig, appVersion, log }) {
  const read = file => fs.readFileSync(path.join(clientDir, file), 'utf8');
  const js = await minifyScript(read('app.js'), log);
  const scriptPath = `/app.${sha256(js, 10)}.js`;
  const render = compileTemplate(read('index.html'), {
    appVersion,
    styles: read('style.css'),
    config: jsonForScript(clientConfig),
    script: scriptPath,
  });
  return { script: { path: scriptPath, body: js }, render };
}

module.exports = { buildShell };
