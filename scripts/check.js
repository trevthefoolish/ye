#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Syntax-checks every JavaScript file in the project with `node --check`.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'logs', 'eval-reports', 'renders', 'data']);

function* jsFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) yield* jsFiles(path.join(dir, entry.name));
    } else if (entry.name.endsWith('.js')) {
      yield path.join(dir, entry.name);
    }
  }
}

let failed = 0;
let checked = 0;
for (const file of jsFiles(ROOT)) {
  checked++;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    process.stderr.write(err.stderr.toString());
  }
}
console.log(`${checked} files checked, ${failed} failed`);
process.exit(failed ? 1 : 0);
