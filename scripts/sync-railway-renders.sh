#!/usr/bin/env bash
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

const localDir = process.argv[2];
const remoteDir = process.argv[3];
fs.mkdirSync(localDir, { recursive: true });

let changedFiles = 0;
for (const file of fs.readdirSync(remoteDir)) {
  if (!file.endsWith('.json')) continue;
  const remotePath = path.join(remoteDir, file);
  const localPath = path.join(localDir, file);
  const remote = JSON.parse(fs.readFileSync(remotePath, 'utf8'));
  let local = {};
  try { local = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch {}

  let changed = false;
  for (const [key, value] of Object.entries(remote)) {
    const existing = local[key];
    if (!existing || existing.v !== value.v || existing.rendering !== value.rendering || existing.note !== value.note) {
      local[key] = value;
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(localPath, JSON.stringify(local, null, 2));
    changedFiles++;
  }
}
console.log(`Updated ${changedFiles} render file(s).`);
NODE

git -C "$ROOT" status --short renders
echo "Review the diff, then commit these render-cache changes in a PR."
