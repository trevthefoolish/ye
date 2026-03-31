// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanupLogs(dir, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const d = new Date(f.replace('.jsonl', ''));
      if (d.getTime() < cutoff) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
  } catch (err) { process.stderr.write('cleanupLogs: ' + err.message + '\n'); }
}

module.exports = { dateStr, cleanupLogs };
