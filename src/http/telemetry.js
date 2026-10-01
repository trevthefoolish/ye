// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// POST /api/log (client error reports) and POST /api/ev (anonymous analytics).
// Both are fire-and-forget beacons: rate-limited per IP before validation,
// and over-limit requests get a silent 204 so clients never retry.

const crypto = require('node:crypto');
const express = require('express');
const { today } = require('../log');

// Fixed-window counter per key.
function createRateLimiter(windowMs, limit) {
  const windows = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, w] of windows) if (w.start < cutoff) windows.delete(key);
  }, 5 * 60_000).unref();
  return key => {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now - w.start > windowMs) {
      w = { start: now, count: 0 };
      windows.set(key, w);
    }
    return ++w.count <= limit;
  };
}

function parseCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const EVENT_TYPES = new Set(['view', 'nav', 'session', 'perf', 'error']);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// Whitelist of analytics fields; anything else a client sends is dropped.
function sanitizeEvent(data) {
  const clean = {
    book: str(data.book, 30),
    ch: num(data.ch),
    method: str(data.method, 10),
    depth: num(data.depth),
    loadMs: num(data.loadMs) === undefined ? undefined : Math.round(data.loadMs),
    ttiMs: num(data.ttiMs) === undefined ? undefined : Math.round(data.ttiMs),
    msg: str(data.msg, 200),
    src: str(data.src, 100),
  };
  for (const key of Object.keys(clean)) if (clean[key] === undefined) delete clean[key];
  return clean;
}

function telemetryRouter({ log, analytics, analyticsSalt = '', secureCookies = false }) {
  const router = express.Router();
  const logAllowed = createRateLimiter(60_000, 30);
  const eventAllowed = createRateLimiter(60_000, 60);

  router.post('/api/log', express.json({ limit: '2kb' }), (req, res) => {
    if (!logAllowed(req.ip)) {
      log.debug('client_error_rate_limited', { ip: req.ip });
      return res.status(204).end();
    }
    const { type, msg, stack, url } = req.body || {};
    if (typeof type !== 'string' || typeof msg !== 'string') return res.status(400).end();
    log.warn('client_error', { type: type.slice(0, 50), msg: msg.slice(0, 500), stack: str(stack, 1000), url: str(url, 200) });
    res.status(204).end();
  });

  router.post('/api/ev', express.json({ limit: '1kb' }), (req, res) => {
    if (!eventAllowed(req.ip)) {
      log.debug('analytics_rate_limited', { ip: req.ip });
      return res.status(204).end();
    }
    const { type, ...data } = req.body || {};
    if (!EVENT_TYPES.has(type)) return res.status(400).end();

    // Daily-rotating anonymous id; the raw IP is never stored.
    const aid = crypto.createHash('sha256').update(analyticsSalt + req.ip + today()).digest('hex').slice(0, 8);
    let sid = parseCookie(req.headers.cookie, 'sid');
    if (!sid || !/^[0-9a-f]{8}$/.test(sid)) sid = crypto.randomBytes(4).toString('hex');
    res.setHeader('Set-Cookie', `sid=${sid}; Path=/api/ev; Max-Age=1800; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`);

    analytics({ ts: new Date().toISOString(), source: 'analytics', type, aid, sid, ...sanitizeEvent(data) });
    res.status(204).end();
  });

  return router;
}

module.exports = { parseCookie, telemetryRouter };
