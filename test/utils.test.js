const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePositiveInt, cleanText, escapeHtml } = require('../utils');

test('cleanText strips em dashes into commas (load-bearing invariant)', () => {
  assert.equal(cleanText('vapour—mist rising'), 'vapour, mist rising');
  assert.equal(cleanText('a—b—c'), 'a, b, c');
  assert.equal(cleanText('no dashes here'), 'no dashes here');
});

test('cleanText enforces British vapour spelling (load-bearing invariant)', () => {
  assert.equal(cleanText('vapor'), 'vapour');
  assert.equal(cleanText('vapors'), 'vapours');
  assert.equal(cleanText('Vapor and VAPORS'), 'vapour and vapours');
  assert.equal(cleanText('evaporate'), 'evaporate');
  assert.equal(cleanText('vaporize'), 'vaporize');
});

test('escapeHtml escapes every dangerous character (load-bearing invariant)', () => {
  assert.equal(
    escapeHtml(`<script>alert("x&y'z\`")</script>`),
    '&lt;script&gt;alert(&quot;x&amp;y&#39;z&#96;&quot;)&lt;/script&gt;'
  );
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('parsePositiveInt accepts positive integers and falls back otherwise', () => {
  assert.equal(parsePositiveInt('8', 4), 8);
  assert.equal(parsePositiveInt('0', 4), 4);
  assert.equal(parsePositiveInt('-2', 4), 4);
  assert.equal(parsePositiveInt('abc', 4), 4);
  assert.equal(parsePositiveInt(undefined, 4), 4);
  assert.equal(parsePositiveInt('12px', 4), 12);
});
