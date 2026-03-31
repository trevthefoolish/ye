// Copyright (c) 2026 vapourware.ai All rights reserved.

function createRateLimiter(windowMs, limit, cleanupMs = 300000) {
  const map = new Map();

  function check(key) {
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      map.set(key, entry);
    }
    entry.count++;
    return entry.count <= limit;
  }

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of map) {
      if (entry.start < cutoff) map.delete(key);
    }
  }, cleanupMs);

  return check;
}

module.exports = createRateLimiter;
