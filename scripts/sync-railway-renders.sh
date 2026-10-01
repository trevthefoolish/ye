#!/usr/bin/env bash
# Copyright (c) 2026 vapourware.ai All rights reserved.
#
# Mirrors production's render cache for the current render version (the one
# this checkout produces with the same RENDER_* variables) into
# renders/<version>/, so it can be reviewed and committed. Other versions'
# directories in renders/ are removed: the committed seed holds one version.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

REMOTE_ROOT="${REMOTE_ROOT:-/data/renders}"
VERSION="$(cd "$ROOT" && node -e '
const { loadConfig, PIPELINE_SECTION } = require("./src/config");
const render = loadConfig().render;
const { version } = render.pipeline === PIPELINE_SECTION
  ? require("./src/render/section-v2").createSectionPipeline(render)
  : require("./src/render/verse-v1").createVersePipeline({ ...render, log: console });
process.stdout.write(version);
')"

echo "Exporting Railway renders from ${REMOTE_ROOT}/${VERSION}..."
railway ssh sh -lc "test -d '${REMOTE_ROOT}/${VERSION}' && tar -C '${REMOTE_ROOT}/${VERSION}' -cf - ." | tar -C "$TMP_DIR" -xf -

node - "$ROOT/renders" "$TMP_DIR" "$VERSION" <<'NODE'
const fs = require('fs');
const path = require('path');

const [seedRoot, exported, version] = process.argv.slice(2);
const isBook = file => /^\d+\.json$/.test(file);
const books = fs.readdirSync(exported).filter(isBook);
if (books.length === 0) {
  console.error(`Production has no renders for ${version}; leaving renders/ untouched.`);
  process.exit(1);
}

const target = path.join(seedRoot, version);
fs.mkdirSync(target, { recursive: true });
for (const file of books) {
  const data = JSON.parse(fs.readFileSync(path.join(exported, file), 'utf8'));
  fs.writeFileSync(path.join(target, file), JSON.stringify(data, null, 2));
}
for (const file of fs.readdirSync(target)) {
  if (isBook(file) && !books.includes(file)) fs.rmSync(path.join(target, file));
}
for (const entry of fs.readdirSync(seedRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name !== version) fs.rmSync(path.join(seedRoot, entry.name), { recursive: true });
}
console.log(`Mirrored ${books.length} book file(s) for render version ${version}.`);
NODE

git -C "$ROOT" status --short renders
echo "Review the diff, then commit these render-cache changes in a PR."
