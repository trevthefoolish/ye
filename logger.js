const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs', 'server');
const RETENTION_DAYS = 7;

// Ensure log directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

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
  fs.appendFile(logPath(dateStr(new Date())), line, () => {});
}

function cleanup() {
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!f.endsWith('.jsonl')) continue;
      const d = new Date(f.replace('.jsonl', ''));
      if (d.getTime() < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, f));
      }
    }
  } catch {}
}

// Clean on startup and daily
cleanup();
setInterval(cleanup, 86400000);

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
