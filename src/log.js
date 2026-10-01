// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Structured JSONL logging. Every line goes to stdout (Railway captures it)
// and to a daily file under LOG_DIR, pruned after a retention window.

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86_400_000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function createSink(dir, retentionDays, stdout) {
  fs.mkdirSync(dir, { recursive: true });

  function write(entry) {
    const line = JSON.stringify(entry) + '\n';
    stdout.write(line);
    fs.appendFile(path.join(dir, today() + '.jsonl'), line, err => {
      // stderr, not the logger: a failing log disk must not recurse into itself.
      if (err) process.stderr.write('log_append_failed: ' + err.message + '\n');
    });
  }

  function prune() {
    const cutoff = Date.now() - retentionDays * DAY_MS;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.endsWith('.jsonl') && new Date(file.slice(0, -6)).getTime() < cutoff) {
          fs.unlinkSync(path.join(dir, file));
        }
      }
    } catch (err) {
      process.stderr.write('log_prune_failed: ' + err.message + '\n');
    }
  }

  return { write, prune };
}

function createLogger(write, { debug = false } = {}) {
  const at = level => (event, data = {}) => write({ ts: new Date().toISOString(), source: 'server', level, event, ...data });
  const noop = () => {};
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: debug ? at('debug') : noop };
}

// Server logs keep 7 days; anonymous analytics keep 30.
function openLogs({ dir, debug, stdout = process.stdout }) {
  const server = createSink(path.join(dir, 'server'), 7, stdout);
  const analytics = createSink(path.join(dir, 'analytics'), 30, stdout);
  const prune = () => { server.prune(); analytics.prune(); };
  prune();
  setInterval(prune, DAY_MS).unref();
  return { log: createLogger(server.write, { debug }), analytics: analytics.write };
}

// For tests: keeps entries in memory instead of writing them.
function memoryLogger() {
  const entries = [];
  const log = createLogger(entry => entries.push(entry), { debug: true });
  log.entries = entries;
  return log;
}

module.exports = { memoryLogger, openLogs, today };
