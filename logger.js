// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');
const { dateStr, cleanupLogs } = require('./logUtils');

const LOG_DIR = path.join(__dirname, 'logs', 'server');
const RETENTION_DAYS = 7;

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

function logPath(date) {
  return path.join(LOG_DIR, date + '.jsonl');
}

function write(level, event, data) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(logPath(dateStr()), line, () => {});
}

// Clean on startup and daily
cleanupLogs(LOG_DIR, RETENTION_DAYS);
setInterval(() => cleanupLogs(LOG_DIR, RETENTION_DAYS), 86400000);

const log = {
  info: (event, data = {}) => write('info', event, data),
  warn: (event, data = {}) => write('warn', event, data),
  error: (event, data = {}) => write('error', event, data),
};

// Express router for client-side error reporting
const express = require('express');
const router = express.Router();

router.post('/api/log', express.json({ limit: '2kb' }), (req, res) => {
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

module.exports = { log, router };
