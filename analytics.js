const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const LOG_DIR = path.join(__dirname, 'logs', 'analytics');
const RETENTION_DAYS = 30;
const RATE_WINDOW_MS = 60000;
const RATE_LIMIT = 60;

const VALID_TYPES = new Set(['view', 'nav', 'session', 'perf', 'error']);

fs.mkdirSync(LOG_DIR, { recursive: true });

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

// Rate limiting per hashed IP
const rateMap = new Map();

function checkRate(ip) {
  const now = Date.now();
  let entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateMap.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

// Cleanup stale rate entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, entry] of rateMap) {
    if (entry.start < cutoff) rateMap.delete(ip);
  }
}, 300000);

// Cleanup old log files
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
cleanup();
setInterval(cleanup, 86400000);

const router = express.Router();

router.post('/api/ev', express.json({ limit: '1kb' }), (req, res) => {
  const { type, ...data } = req.body || {};

  if (!VALID_TYPES.has(type)) return res.status(400).end();
  if (!checkRate(req.ip)) return res.status(429).end();

  // Anonymize IP to 8-char hash
  const anonId = crypto.createHash('sha256').update(req.ip + dateStr()).digest('hex').slice(0, 8);

  const entry = {
    ts: new Date().toISOString(),
    type,
    aid: anonId,
    ...sanitize(data),
  };

  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(path.join(LOG_DIR, dateStr() + '.jsonl'), line, () => {});
  res.status(204).end();
});

// Whitelist and truncate event fields to prevent abuse
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

module.exports = router;
