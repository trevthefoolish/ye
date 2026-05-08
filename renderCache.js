// Copyright (c) 2026 vapourware.ai All rights reserved.

function isRenderEntry(entry) {
  return !!entry
    && typeof entry === 'object'
    && typeof entry.rendering === 'string'
    && typeof entry.note === 'string'
    && typeof entry.v === 'string';
}

function sameRenderContent(a, b) {
  return isRenderEntry(a)
    && isRenderEntry(b)
    && a.v === b.v
    && a.rendering === b.rendering
    && a.note === b.note;
}

function mergeSeedRenderCache(sourceData, destData, renderVersion, opts = {}) {
  const next = { ...(destData && typeof destData === 'object' ? destData : {}) };
  const source = sourceData && typeof sourceData === 'object' ? sourceData : {};
  const destFileMalformed = opts.destFileMalformed === true;
  const stats = {
    changed: false,
    entriesAdded: 0,
    entriesReplaced: 0,
    entriesSkippedStaleSource: 0,
    entriesSkippedMalformed: 0,
  };

  for (const [key, value] of Object.entries(source)) {
    if (!isRenderEntry(value)) {
      stats.entriesSkippedMalformed++;
      continue;
    }
    if (value.v !== renderVersion) {
      stats.entriesSkippedStaleSource++;
      continue;
    }

    const existing = next[key];
    if (!(key in next)) {
      next[key] = value;
      stats.changed = true;
      if (destFileMalformed) stats.entriesReplaced++;
      else stats.entriesAdded++;
      continue;
    }

    if (!sameRenderContent(existing, value)) {
      next[key] = value;
      stats.changed = true;
      stats.entriesReplaced++;
    }
  }

  return { cache: next, ...stats };
}

module.exports = {
  isRenderEntry,
  mergeSeedRenderCache,
};
