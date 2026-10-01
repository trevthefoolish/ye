#!/usr/bin/env bash
# Copyright (c) 2026 vapourware.ai All rights reserved.
#
# Mirrors the production render cache (Railway volume) into renders/ so it can
# be reviewed and committed. Production only holds the current render
# version, so local book files are replaced, and removed if production has none.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REMOTE_MOUNT="${REMOTE_MOUNT:-/data/renders}"

echo "Exporting Railway renders from ${REMOTE_MOUNT}..."
railway ssh sh -lc "test -d '${REMOTE_MOUNT}' && tar -C '${REMOTE_MOUNT}' -cf - ." | tar -C "$TMP_DIR" -xf -

node - "$ROOT/renders" "$TMP_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');

const [localDir, remoteDir] = process.argv.slice(2);
const isBook = file => /^\d+\.json$/.test(file);
const remote = fs.readdirSync(remoteDir).filter(isBook);
if (remote.length === 0) {
  console.error('Production export has no render files; leaving renders/ untouched.');
  process.exit(1);
}

fs.mkdirSync(localDir, { recursive: true });
for (const file of remote) {
  const data = JSON.parse(fs.readFileSync(path.join(remoteDir, file), 'utf8'));
  fs.writeFileSync(path.join(localDir, file), JSON.stringify(data, null, 2));
}
const removed = fs.readdirSync(localDir).filter(file => isBook(file) && !remote.includes(file));
for (const file of removed) fs.rmSync(path.join(localDir, file));
console.log(`Mirrored ${remote.length} render file(s); removed ${removed.length}.`);
NODE

git -C "$ROOT" status --short renders
echo "Review the diff, then commit these render-cache changes in a PR."
