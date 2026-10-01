'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');

test('local runs cache and log in gitignored directories', () => {
  const { cache, logs } = loadConfig({});
  assert.equal(cache.dir, path.join(ROOT, '.cache', 'renders'));
  assert.equal(logs.dir, path.join(ROOT, 'logs'));
  assert.equal(loadConfig({ RENDERS_DIR: '  ' }).cache.dir, cache.dir);
});

test('on Railway, renders and logs live on the attached volume with no other settings', () => {
  const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', XAI_API_KEY: 'k' });
  assert.equal(config.cache.dir, '/data/renders');
  assert.equal(config.logs.dir, '/data/logs');
  assert.equal(config.render.model, 'grok-4.7');
});

test('render timeouts leave headroom for grok-4.7 reasoning latency', () => {
  // Production saw ~20 s for a single verse on average and a quarter of calls past 30 s.
  assert.equal(loadConfig({}).render.passageTimeoutMs, 120_000);
});

test('explicit RENDERS_DIR and LOG_DIR still win over the volume', () => {
  const config = loadConfig({ RAILWAY_VOLUME_MOUNT_PATH: '/data', RENDERS_DIR: '/srv/renders', LOG_DIR: '/var/log/ye' });
  assert.equal(config.cache.dir, '/srv/renders');
  assert.equal(config.logs.dir, '/var/log/ye');
});
