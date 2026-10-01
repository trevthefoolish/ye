'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, escapeHtml, jsonForScript, parsePositiveInt } = require('../src/text');

test('cleanText turns em dashes into commas', () => {
  assert.equal(cleanText('vapour—mist rising'), 'vapour, mist rising');
  assert.equal(cleanText('a—b—c'), 'a, b, c');
  assert.equal(cleanText('no dashes here'), 'no dashes here');
});

test('cleanText enforces "vapour", keeping case, without touching other words', () => {
  assert.equal(cleanText('vapor'), 'vapour');
  assert.equal(cleanText('vapors'), 'vapours');
  assert.equal(cleanText('Vapor of vapors'), 'Vapour of vapours');
  assert.equal(cleanText('VAPOR and VAPORS'), 'VAPOUR and VAPOURS');
  assert.equal(cleanText('vapour stays vapour'), 'vapour stays vapour');
  assert.equal(cleanText('evaporate'), 'evaporate');
  assert.equal(cleanText('vaporize'), 'vaporize');
});

test('escapeHtml escapes every character that can break out of markup', () => {
  assert.equal(
    escapeHtml(`<script>alert("x&y'z\`")</script>`),
    '&lt;script&gt;alert(&quot;x&amp;y&#39;z&#96;&quot;)&lt;/script&gt;'
  );
  assert.equal(escapeHtml('plain text'), 'plain text');
});

test('jsonForScript cannot close or comment out its script element', () => {
  const json = jsonForScript({ text: '</script><script>alert(1)</script><!-- $& $\'' });
  assert.ok(!json.includes('<'));
  assert.deepEqual(JSON.parse(json), { text: '</script><script>alert(1)</script><!-- $& $\'' });
});

test('parsePositiveInt accepts positive integers and falls back otherwise', () => {
  assert.equal(parsePositiveInt('8', 4), 8);
  assert.equal(parsePositiveInt('12px', 4), 12);
  for (const bad of ['0', '-2', 'abc', undefined, '']) assert.equal(parsePositiveInt(bad, 4), 4);
});
