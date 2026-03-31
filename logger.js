// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const createRateLimiter = require('./rateLimit');
const { dateStr, cleanupLogs } = require('./logUtils');

// --- Shared JSONL writer ---
function writeLine(dir, entry) {
  const line = JSON.stringify(entry) + '\n';
  process.stdout.write(line);
  fs.appendFile(path.join(dir, dateStr() + '.jsonl'), line, () => {});
}

// --- Server logging (7-day retention) ---
const SERVER_DIR = path.join(__dirname, 'logs', 'server');
fs.mkdirSync(SERVER_DIR, { recursive: true });

const log = {
  info:  (event, data = {}) => writeLine(SERVER_DIR, { ts: new Date().toISOString(), source: 'server', level: 'info',  event, ...data }),
  warn:  (event, data = {}) => writeLine(SERVER_DIR, { ts: new Date().toISOString(), source: 'server', level: 'warn',  event, ...data }),
  error: (event, data = {}) => writeLine(SERVER_DIR, { ts: new Date().toISOString(), source: 'server', level: 'error', event, ...data }),
};

// --- Client error reporting ---
const logRouter = express.Router();

logRouter.post('/api/log', express.json({ limit: '2kb' }), (req, res) => {
  const { type, msg, stack, url } = req.body || {};
  if (typeof type !== 'string' || typeof msg !== 'string') {
    return res.status(400).end();
  }
  log.warn('client_error', {
    type: String(type).slice(0, 50),
    msg: String(msg).slice(0, 500),
    stack: typeof stack === 'string' ? stack.slice(0, 1000) : undefined,
    url: typeof url === 'string' ? url.slice(0, 200) : undefined,
  });
  res.status(204).end();
});

// --- Analytics (30-day retention) ---
const ANALYTICS_DIR = path.join(__dirname, 'logs', 'analytics');
fs.mkdirSync(ANALYTICS_DIR, { recursive: true });

const VALID_TYPES = new Set(['view', 'nav', 'session', 'perf', 'error']);
const checkAnalyticsRate = createRateLimiter(60000, 60);

function sanitize(data) {
  const clean = {};
  if (typeof data.book === 'string') clean.book = data.book.slice(0, 30);
  if (typeof data.ch === 'number' && Number.isFinite(data.ch)) clean.ch = data.ch;
  if (typeof data.method === 'string') clean.method = data.method.slice(0, 10);
  if (typeof data.depth === 'number' && Number.isFinite(data.depth)) clean.depth = data.depth;
  if (typeof data.loadMs === 'number' && Number.isFinite(data.loadMs)) clean.loadMs = Math.round(data.loadMs);
  if (typeof data.ttiMs === 'number' && Number.isFinite(data.ttiMs)) clean.ttiMs = Math.round(data.ttiMs);
  if (typeof data.msg === 'string') clean.msg = data.msg.slice(0, 200);
  if (typeof data.src === 'string') clean.src = data.src.slice(0, 100);
  return clean;
}

const analyticsRouter = express.Router();

analyticsRouter.post('/api/ev', express.json({ limit: '1kb' }), (req, res) => {
  const { type, ...data } = req.body || {};
  if (!VALID_TYPES.has(type)) return res.status(400).end();
  if (!checkAnalyticsRate(req.ip)) return res.status(429).end();

  const anonId = crypto.createHash('sha256').update(req.ip + dateStr()).digest('hex').slice(0, 8);

  writeLine(ANALYTICS_DIR, {
    ts: new Date().toISOString(),
    source: 'analytics',
    type,
    aid: anonId,
    ...sanitize(data),
  });
  res.status(204).end();
});

// --- Cleanup: both directories, one schedule ---
cleanupLogs(SERVER_DIR, 7);
cleanupLogs(ANALYTICS_DIR, 30);
setInterval(() => {
  cleanupLogs(SERVER_DIR, 7);
  cleanupLogs(ANALYTICS_DIR, 30);
}, 86400000);

module.exports = { log, logRouter, analyticsRouter };
