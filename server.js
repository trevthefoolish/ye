// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Entry point: wires configuration, logging, the render cache, the render
// pipeline, and the web app, then listens.

const path = require('node:path');
const { BOOKS, CHAPTER_COUNTS } = require('./src/canon');
const { loadConfig, PIPELINE_SECTION } = require('./src/config');
const { openLogs } = require('./src/log');
const { createApp } = require('./src/http/app');
const { buildShell } = require('./src/http/shell');
const { createRenderer } = require('./src/render/renderer');
const { createSectionPipeline } = require('./src/render/section-v2');
const { RenderStore } = require('./src/render/store');
const { createVersePipeline } = require('./src/render/verse-v1');

const APP_VERSION = require('./package.json').version;
const SHUTDOWN_GRACE_MS = 5_000;

async function main() {
  const config = loadConfig();
  const { log, analytics } = openLogs(config.logs);
  process.on('unhandledRejection', reason => log.error('unhandled_rejection', { err: String(reason) }));
  if (!config.render.apiKey) {
    log.error('missing_api_key');
    process.exit(1);
  }

  const pipeline = config.render.pipeline === PIPELINE_SECTION
    ? createSectionPipeline(config.render)
    : createVersePipeline({ ...config.render, log });

  const store = new RenderStore({ dir: config.cache.dir, version: pipeline.version, log });
  store.prepare(config.cache.seed ? config.cache.seedDir : null);

  const { concurrency, retries, retryBaseMs } = config.render;
  const renderer = createRenderer({ pipeline, store, log, concurrency, retries, retryBaseMs });

  const shell = await buildShell({
    clientDir: path.join(config.root, 'client'),
    clientConfig: { books: BOOKS, chapters: CHAPTER_COUNTS, rv: pipeline.version, v: APP_VERSION },
    appVersion: APP_VERSION,
    log,
  });

  const app = createApp({ config, log, analytics, store, renderer, pipeline, shell, appVersion: APP_VERSION });

  // Express 5 passes listen errors to the callback (server.address() is null then).
  const server = app.listen(config.port, err => {
    if (err) {
      log.error('listen_failed', { port: config.port, err: err.message });
      process.exit(1);
    }
    // The assigned port, not the requested one, so PORT=0 works in tests.
    log.info('server_started', {
      port: server.address().port,
      version: APP_VERSION,
      renderPipeline: pipeline.name,
      renderModel: config.render.model,
      reasoningEffort: config.render.reasoningEffort,
      renderVersion: pipeline.version,
    });
  });

  // Railway sends SIGTERM on redeploy: stop accepting, let cache writes land.
  const shutdown = signal => {
    log.info('server_stopping', { signal });
    server.close();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
    store.flush().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch(err => {
  process.stderr.write(`startup_failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
