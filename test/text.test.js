'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanText, escapeHtml, jsonForScript, parsePositiveInt } = require('../src/text');

test('cleanText turns em dashes into commas, whatever space is around them', () => {
  assert.equal(cleanText('vapour—mist rising'), 'vapour, mist rising');
  assert.equal(cleanText('a—b—c'), 'a, b, c');
  assert.equal(cleanText('James’s brother — James — writes'), 'James’s brother, James, writes');
  assert.equal(cleanText('brother —James'), 'brother, James');
  assert.equal(cleanText('brother— James'), 'brother, James');
  assert.equal(cleanText('two dashes——here'), 'two dashes, here');
  // A sentence that runs on into the next verse keeps a plain trailing comma.
  assert.equal(cleanText('the cosmetics used for women—'), 'the cosmetics used for women,');
  assert.equal(cleanText('to those bitter in soul —'), 'to those bitter in soul,');
  assert.equal(cleanText('no dashes here'), 'no dashes here');
  assert.equal(cleanText('Grace, mercy, and peace,'), 'Grace, mercy, and peace,');
});

test('cleanText repairs text cleaned by its earlier version, and cleaning twice changes nothing', () => {
  // What the earlier version made of real verses (production, Ecclesiastes 3 and Esther 2).
  assert.equal(cleanText('in all their work ,  this too is God’s gift.'), 'in all their work, this too is God’s gift.');
  assert.equal(cleanText('for every deed ,  there.'), 'for every deed, there.');
  assert.equal(cleanText('brother , James and brother,  John'), 'brother, James and brother, John');
  assert.equal(cleanText('the cosmetics used for women, '), 'the cosmetics used for women,');
  for (const s of ['a — b', 'a—', 'a ,  b', 'Vapor —of vapors—', 'plain, text.']) {
    assert.equal(cleanText(cleanText(s)), cleanText(s), s);
  }
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
