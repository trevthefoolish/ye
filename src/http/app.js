// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// The Express application: security headers, compression, routes, errors.

const path = require('node:path');
const compression = require('compression');
const express = require('express');
const { apiRoutes } = require('./api');
const { DEFAULT_PATH, isAssetPath, pageRoutes } = require('./pages');
const { telemetryRouter } = require('./telemetry');

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(production) {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', CSP);
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

function errorHandler(log) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const isApi = req.path.startsWith('/api/');
    // Undecodable URLs (e.g. "/%E0%A4%A") are client mistakes, not failures.
    if (err instanceof URIError) {
      if (isApi) return res.status(400).json({ error: 'bad request' });
      if (isAssetPath(req.path)) return res.status(404).end();
      return res.redirect(302, DEFAULT_PATH);
    }
    // Malformed or oversized JSON beacons.
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      log.debug('bad_request_body', { path: req.path, type: err.type });
      return res.status(err.status || 400).json({ error: 'bad request' });
    }
    log.error('request_failed', { path: req.path, err: err.message });
    if (isApi) return res.status(500).json({ error: 'internal server error' });
    res.status(500).type('text').send('Internal server error');
  };
}

function createApp({ config, log, analytics, store, renderer, pipeline, shell, appVersion }) {
  const app = express();
  app.disable('x-powered-by');
  // Fastly (CDN) -> Railway edge -> Node. Trusting exactly two hops makes
  // req.ip the real client for rate limiting and analytics without letting
  // a client spoof it through X-Forwarded-For.
  app.set('trust proxy', 2);

  app.use(securityHeaders(config.production));
  app.use(compression());
  app.use(telemetryRouter({ log, analytics, analyticsSalt: config.logs.analyticsSalt, secureCookies: config.production }));
  app.get('/health', (req, res) => res.json({ status: 'ok', version: appVersion }));
  app.use(apiRoutes({ store, renderer, pipeline, render: config.render, appVersion }));
  app.use(express.static(path.join(config.root, 'public'), { index: false }));
  app.use(pageRoutes({ shell, store, origin: config.origin }));
  app.use(errorHandler(log));
  return app;
}

module.exports = { createApp };
