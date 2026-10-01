'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');

test('local runs cache outside the committed renders/', () => {
  const { cache, logs } = loadConfig({});
  assert.equal(cache.dir, path.join(ROOT, '.cache', 'renders'));
  assert.notEqual(cache.dir, cache.seedDir);
  assert.deepEqual(cache.retiredDirs, []);
  assert.equal(logs.dir, path.join(ROOT, 'logs'));
  assert.equal(loadConfig({ RENDERS_DIR: '  ' }).cache.dir, cache.dir);
});

test('on Railway, renders and logs live on the attached volume with no other settings', () => {
  const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', XAI_API_KEY: 'k' });
  assert.equal(config.cache.dir, '/data/renders');
  assert.equal(config.logs.dir, '/data/logs');
  assert.deepEqual(config.cache.retiredDirs, ['/data/renders-v2']);
  assert.equal(config.render.pipeline, 'passage-v1');
  assert.equal(config.render.model, 'grok-4.7');
});

test('RENDER_PIPELINE selects an older pipeline by name; anything else is passage-v1', () => {
  assert.equal(loadConfig({ RENDER_PIPELINE: 'verse-v1' }).render.pipeline, 'verse-v1');
  assert.equal(loadConfig({ RENDER_PIPELINE: ' section-v2 ' }).render.pipeline, 'section-v2');
  for (const value of [undefined, '', 'passage-v1', 'verse-v2']) {
    assert.equal(loadConfig({ RENDER_PIPELINE: value }).render.pipeline, 'passage-v1', String(value));
  }
});

test('render timeouts leave headroom for grok-4.7 reasoning latency', () => {
  // Production saw ~20 s per verse on average and a quarter of calls past 30 s.
  const { render } = loadConfig({});
  assert.equal(render.verseTimeoutMs, 90_000);
  assert.equal(render.passageTimeoutMs, 120_000);
  assert.equal(render.sectionTimeoutMs, 90_000);
});

test('explicit RENDERS_DIR and LOG_DIR still win over the volume', () => {
  const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', RENDERS_DIR: '/data/renders-v2', LOG_DIR: '/var/log/ye' });
  assert.equal(config.cache.dir, '/data/renders-v2');
  assert.equal(config.logs.dir, '/var/log/ye');
});
