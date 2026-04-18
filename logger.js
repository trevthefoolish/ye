// Copyright (c) 2026 vapourware.ai All rights reserved.
const { PostHog } = require('posthog-node');

const POSTHOG_KEY = process.env.POSTHOG_API_KEY || 'phc_DeGddwT7kdQWAAo2j4jcxubGE5jEM7qjFvDhEUyxq4th';

const posthog = new PostHog(POSTHOG_KEY, {
  host: 'https://us.i.posthog.com',
  flushAt: 20,
  flushInterval: 10000,
});

// Graceful shutdown
process.on('SIGTERM', async () => { await posthog.shutdown(); process.exit(0); });
process.on('SIGINT', async () => { await posthog.shutdown(); process.exit(0); });

// --- Server logging via PostHog ---
function makeLog(level) {
  return (event, data = {}) => {
    posthog.capture({ distinctId: 'server', event: `server_${event}`, properties: { level, ...data } });
  };
}
const log = { info: makeLog('info'), warn: makeLog('warn'), error: makeLog('error') };

// --- Cookie parser (kept for lastPos) ---
function parseCookie(header, name) {
  if (!header) return null;
  const match = header.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

module.exports = { log, parseCookie, POSTHOG_KEY };
