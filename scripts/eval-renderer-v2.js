#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
'use strict';

// Renders an eval set through the section pipeline and writes Markdown + JSON
// reports. Never touches the render cache.
//
//   EVAL_SET=smoke|edge|prod-sim   which scenarios (default smoke)
//   EVAL_GATE=1                    exit non-zero on hard structural failures
//   EVAL_REPORTS_DIR=...           where reports go (default eval-reports/)
//   XAI_API_KEY, XAI_API_URL, RENDER_MODEL, RENDER_REASONING_EFFORT,
//   RENDER_SECTION_TIMEOUT_MS      as for the server

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, PIPELINE_SECTION } = require('../src/config');
const { EVAL_SCENARIOS_VERSION, evalSections } = require('../src/render/section-eval');
const { PROMPT_VERSION, SCHEMA_VERSION, renderSection, sectionMap, sectionRef } = require('../src/render/section-v2');
const { cleanText, slugify } = require('../src/text');

const RENDER = loadConfig({ ...process.env, RENDER_PIPELINE: PIPELINE_SECTION }).render;
const EVAL_SET = process.env.EVAL_SET || 'smoke';
const EVAL_GATE = process.env.EVAL_GATE === '1' || process.env.EVAL_GATE === 'true';
const REPORTS_DIR = process.env.EVAL_REPORTS_DIR || path.join(__dirname, '..', 'eval-reports');
const NOTE_WORD_WARNING_MAX = 32;
const AVG_NOTE_WORD_WARNING_MIN = 11;
const EM_DASH = /—/g;
const AMERICAN_VAPOR = /\bvapors?\b/gi;

const wordCount = s => s.trim().split(/\s+/).filter(Boolean).length;
const opening = note => note.replace(/["'()]/g, '').split(/\s+/).slice(0, 4).join(' ').replace(/[,:;.]+$/, '');
const statusFor = ok => (ok ? 'pass' : 'warn');
const average = nums => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0);
const matches = (s, re) => (s || '').match(re)?.length || 0;
const entryKey = entry => `${entry.scenarioId || 'unknown'}|${entry.ref}`;

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) counts.set(fn(item), (counts.get(fn(item)) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

// Keys seen more than once, in first-seen order.
function duplicates(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  return [...counts].filter(([, count]) => count > 1).map(([key, count]) => ({ key, count }));
}

function summarizeSectionGroups(sections, noteLengthKeys, echoKeys) {
  const groupings = {
    genre: s => [s.genre || 'unclassified'],
    sectionKind: s => [s.sectionKind || 'unclassified'],
    riskFlags: s => (Array.isArray(s.riskFlags) && s.riskFlags.length ? s.riskFlags : ['none']),
    mode: s => [s.mode || 'unknown'],
    sectionSource: s => [s.sectionSource || s.source || 'unknown'],
  };
  const summaries = {};
  for (const [name, valuesFor] of Object.entries(groupings)) {
    const groups = new Map();
    for (const section of sections) {
      for (const value of valuesFor(section)) {
        if (!groups.has(value)) {
          groups.set(value, { value, sectionCount: 0, verseCount: 0, warningCount: 0, noteLengthWarnings: 0, genericEchoWarnings: 0, christConnections: {}, sections: [] });
        }
        const group = groups.get(value);
        group.sectionCount++;
        group.sections.push(section.ref);
        for (const entry of section.entries) {
          group.verseCount++;
          if (noteLengthKeys.has(entry.key)) { group.noteLengthWarnings++; group.warningCount++; }
          if (echoKeys.has(entry.key)) { group.genericEchoWarnings++; group.warningCount++; }
          const connection = entry.christConnection || 'missing';
          group.christConnections[connection] = (group.christConnections[connection] || 0) + 1;
        }
      }
    }
    summaries[name] = [...groups.values()].sort((a, b) => b.warningCount - a.warningCount || b.verseCount - a.verseCount || a.value.localeCompare(b.value));
  }
  return summaries;
}

function buildReferenceIntegrity(sections, rendered) {
  const expected = new Set(sections.flatMap(s => (s.targetReferences || s.references || []).map(ref => `${s.scenarioId || 'unknown'}|${ref}`)));
  const actual = new Set(rendered.map(entryKey));
  return {
    expectedCount: expected.size,
    actualCount: actual.size,
    duplicateRenderedRefs: duplicates(rendered.map(entryKey)),
    missingRenderedRefs: [...expected].filter(key => !actual.has(key)).sort(),
    unexpectedRenderedRefs: [...actual].filter(key => !expected.has(key)).sort(),
  };
}

function reportMetadataMissing(report) {
  const missing = [];
  for (const key of ['evalSet', 'model', 'reasoningEffort', 'promptVersion', 'schemaVersion', 'sectionsVersion', 'sectionsFingerprint', 'evalScenariosVersion', 'apiUrl']) {
    if (!report.config[key]) missing.push(`config.${key}`);
  }
  for (const section of report.sections) {
    for (const key of ['scenarioId', 'mode', 'sectionSource', 'evalSet', 'ref']) {
      if (!section[key]) missing.push(`sections.${section.ref || 'unknown'}.${key}`);
    }
  }
  for (const entry of report.rendered) {
    for (const key of ['scenarioId', 'mode', 'sectionSource', 'evalSet', 'sectionRef', 'ref']) {
      if (!entry[key]) missing.push(`rendered.${entry.ref || 'unknown'}.${key}`);
    }
    if (!Array.isArray(entry.riskFlags)) missing.push(`rendered.${entry.ref || 'unknown'}.riskFlags`);
  }
  return missing;
}

function buildEvalReport({ generatedAt = new Date(), evalSet = EVAL_SET, sections, rendered }) {
  const entries = rendered.map(entry => ({ ...entry, key: entryKey(entry) }));
  const complete = entries.filter(e => e.rendering && e.note && e.noteKind && e.christConnection);
  const noteWords = entries.map(e => wordCount(e.note));
  const avgNoteWords = average(noteWords);
  const longNotes = entries.filter(e => wordCount(e.note) > NOTE_WORD_WARNING_MAX);
  const echoNotes = entries.filter(e => /\becho(?:es|ing|ed)?\b/i.test(e.note));
  const repeatedOpenings = countBy(entries, e => opening(e.note)).filter(([, count]) => count > 1);
  const christReviewRefs = entries
    .filter(e => e.christConnection !== 'none')
    .map(e => ({ ref: e.ref, scenarioId: e.scenarioId, christConnection: e.christConnection, note: e.note }));
  const rawHas = re => entries.filter(e => matches(e.rawRendering, re) || matches(e.rawNote, re)).map(e => e.ref);
  const cleanHas = re => entries.filter(e => matches(e.rendering, re) || matches(e.note, re)).map(e => e.ref);

  const groupedSections = sections.map(section => {
    const ref = sectionRef(section);
    const scenarioId = section.scenarioId || null;
    const sectionSource = section.source || 'unknown';
    return {
      ref,
      label: section.label,
      scenarioId,
      scenarioLabel: section.scenarioLabel || null,
      mode: section.mode || null,
      source: sectionSource,
      sectionSource,
      genre: section.genre || null,
      sectionKind: section.sectionKind || null,
      riskFlags: Array.isArray(section.riskFlags) ? section.riskFlags : [],
      evalSet: section.evalSet || evalSet,
      evalSets: Array.isArray(section.evalSets) ? section.evalSets : [],
      targetReferences: section.targetReferences || section.references || [],
      manualReview: { status: 'pending', notes: '' },
      entries: entries.filter(e => e.scenarioId === scenarioId && e.sectionRef === ref),
    };
  });
  const referenceIntegrity = buildReferenceIntegrity(sections, entries);
  const map = sectionMap();

  const metrics = {
    verses: entries.length,
    schemaComplete: `${complete.length}/${entries.length}`,
    schemaCompleteCount: complete.length,
    echoNotes: echoNotes.length,
    avgNoteWords,
    avgNoteChars: average(entries.map(e => e.note.length)),
    repeatedOpenings: Object.fromEntries(repeatedOpenings),
    noteKinds: Object.fromEntries(countBy(entries, e => e.noteKind)),
    christConnections: Object.fromEntries(countBy(entries, e => e.christConnection)),
    rawEmDashCount: entries.reduce((n, e) => n + matches(e.rawRendering, EM_DASH) + matches(e.rawNote, EM_DASH), 0),
    cleanedEmDashCount: entries.reduce((n, e) => n + matches(e.rendering, EM_DASH) + matches(e.note, EM_DASH), 0),
    rawAmericanVaporCount: entries.reduce((n, e) => n + matches(e.rawRendering, AMERICAN_VAPOR) + matches(e.rawNote, AMERICAN_VAPOR), 0),
    cleanedAmericanVaporCount: entries.reduce((n, e) => n + matches(e.rendering, AMERICAN_VAPOR) + matches(e.note, AMERICAN_VAPOR), 0),
    sectionCount: groupedSections.length,
    maxTargetVerses: groupedSections.length ? Math.max(...groupedSections.map(s => s.targetReferences.length)) : 0,
    sectionSources: Object.fromEntries(countBy(groupedSections, s => s.sectionSource)),
    referenceIntegrity,
  };

  const report = {
    evalName: `renderer-v2-${evalSet}`,
    generatedAt: generatedAt.toISOString(),
    config: {
      evalSet,
      model: RENDER.model,
      reasoningEffort: RENDER.reasoningEffort,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      sectionsVersion: map.version,
      sectionsFingerprint: map.fingerprint,
      evalScenariosVersion: EVAL_SCENARIOS_VERSION,
      apiUrl: RENDER.apiUrl,
      gate: EVAL_GATE,
    },
    metrics,
    groupSummaries: summarizeSectionGroups(groupedSections, new Set(longNotes.map(e => e.key)), new Set(echoNotes.map(e => e.key))),
    rubric: {
      schemaCompleteness: {
        status: statusFor(complete.length === entries.length),
        result: metrics.schemaComplete,
        refsNeedingReview: entries.filter(e => !complete.includes(e)).map(e => e.ref),
      },
      referenceIntegrity: {
        status: statusFor(referenceIntegrity.duplicateRenderedRefs.length === 0
          && referenceIntegrity.missingRenderedRefs.length === 0
          && referenceIntegrity.unexpectedRenderedRefs.length === 0),
        ...referenceIntegrity,
      },
      noteLength: {
        status: statusFor(longNotes.length === 0 && avgNoteWords >= AVG_NOTE_WORD_WARNING_MIN),
        notesOver32Words: longNotes.map(e => e.ref),
        avgNoteWords,
        minAvgNoteWords: AVG_NOTE_WORD_WARNING_MIN,
        maxNoteWords: NOTE_WORD_WARNING_MAX,
      },
      repeatedOpenings: { status: statusFor(repeatedOpenings.length === 0), openings: Object.fromEntries(repeatedOpenings) },
      genericEchoLanguage: { status: statusFor(echoNotes.length === 0), refs: echoNotes.map(e => e.ref) },
      forcedChristConnections: {
        status: christReviewRefs.length ? 'review' : 'pass',
        note: 'Manual review required for non-none Christ connections.',
        refs: christReviewRefs,
      },
      emDashRemoval: { status: statusFor(cleanHas(EM_DASH).length === 0), rawRefs: rawHas(EM_DASH), cleanedRefs: cleanHas(EM_DASH) },
      vapourSpelling: { status: statusFor(cleanHas(AMERICAN_VAPOR).length === 0), rawRefs: rawHas(AMERICAN_VAPOR), cleanedRefs: cleanHas(AMERICAN_VAPOR) },
      reportMetadata: { status: 'pass', missing: [] },
      manualSectionReview: {
        status: 'pending',
        sections: groupedSections.map(s => ({
          ref: s.ref, scenarioId: s.scenarioId, mode: s.mode, sectionSource: s.sectionSource, label: s.label,
          status: s.manualReview.status, notes: s.manualReview.notes,
        })),
      },
    },
    sections: groupedSections,
    rendered: entries,
  };
  report.rubric.reportMetadata.missing = reportMetadataMissing(report);
  report.rubric.reportMetadata.status = statusFor(report.rubric.reportMetadata.missing.length === 0);
  return report;
}

// --- Markdown ---

function markdownList(items) {
  if (!items || items.length === 0) return 'none';
  return items.map(item => {
    if (typeof item === 'string') return item;
    if (item.ref && item.christConnection) return `${item.ref} (${item.christConnection})`;
    if (item.key && item.count) return `${item.key} x${item.count}`;
    return JSON.stringify(item);
  }).join(', ');
}

const cell = value => String(value).replace(/\|/g, '\\|');
const jsonOrNone = obj => (Object.keys(obj).length ? JSON.stringify(obj) : 'none');

function groupTable(title, rows) {
  return [
    `## ${title}`, '',
    '| Value | Sections | Verses | Warnings | Note length | Generic echo | Christ connections |',
    '|---|---:|---:|---:|---:|---:|---|',
    ...rows.map(r => `| ${r.value} | ${r.sectionCount} | ${r.verseCount} | ${r.warningCount} | ${r.noteLengthWarnings} | ${r.genericEchoWarnings} | ${cell(jsonOrNone(r.christConnections))} |`),
    '',
  ];
}

function buildMarkdownReport(report) {
  const { config, metrics, rubric } = report;
  const rubricRows = [
    ['Schema completeness', rubric.schemaCompleteness.status, rubric.schemaCompleteness.result],
    ['Reference integrity', rubric.referenceIntegrity.status, `duplicates: ${markdownList(rubric.referenceIntegrity.duplicateRenderedRefs)}; missing: ${markdownList(rubric.referenceIntegrity.missingRenderedRefs)}; unexpected: ${markdownList(rubric.referenceIntegrity.unexpectedRenderedRefs)}`],
    ['Note length', rubric.noteLength.status, `>32 words: ${markdownList(rubric.noteLength.notesOver32Words)}; avg words: ${rubric.noteLength.avgNoteWords}; target avg >= ${rubric.noteLength.minAvgNoteWords}`],
    ['Repeated openings', rubric.repeatedOpenings.status, jsonOrNone(rubric.repeatedOpenings.openings)],
    ['Generic echo language', rubric.genericEchoLanguage.status, markdownList(rubric.genericEchoLanguage.refs)],
    ['Forced Christ connections', rubric.forcedChristConnections.status, markdownList(rubric.forcedChristConnections.refs)],
    ['Em dash removal', rubric.emDashRemoval.status, `raw: ${markdownList(rubric.emDashRemoval.rawRefs)}; cleaned: ${markdownList(rubric.emDashRemoval.cleanedRefs)}`],
    ['Vapour spelling', rubric.vapourSpelling.status, `raw: ${markdownList(rubric.vapourSpelling.rawRefs)}; cleaned: ${markdownList(rubric.vapourSpelling.cleanedRefs)}`],
    ['Report metadata', rubric.reportMetadata.status, markdownList(rubric.reportMetadata.missing)],
    ['Manual section review', rubric.manualSectionReview.status, 'Fill in pass/fail and notes for each section before merge.'],
  ];

  const lines = [
    `# Renderer v2 ${config.evalSet} eval`, '',
    `Generated: ${report.generatedAt}`, '',
    '## Config', '',
    `- evalSet: ${config.evalSet}`,
    `- model: ${config.model}`,
    `- reasoning: ${config.reasoningEffort}`,
    `- prompt: ${config.promptVersion}`,
    `- schema: ${config.schemaVersion}`,
    `- sections: ${config.sectionsVersion}`,
    `- sections fingerprint: ${config.sectionsFingerprint}`,
    `- eval scenarios: ${config.evalScenariosVersion}`,
    `- gate: ${config.gate ? 'on' : 'off'}`,
    '',
    '## Metrics', '',
    `- verses: ${metrics.verses}`,
    `- sections: ${metrics.sectionCount}`,
    `- maxTargetVerses: ${metrics.maxTargetVerses}`,
    `- sectionSources: ${JSON.stringify(metrics.sectionSources)}`,
    `- schemaComplete: ${metrics.schemaComplete}`,
    `- echoNotes: ${metrics.echoNotes}`,
    `- avgNoteWords: ${metrics.avgNoteWords}`,
    `- avgNoteChars: ${metrics.avgNoteChars}`,
    `- repeatedOpenings: ${jsonOrNone(metrics.repeatedOpenings)}`,
    `- noteKinds: ${JSON.stringify(metrics.noteKinds)}`,
    `- christConnections: ${JSON.stringify(metrics.christConnections)}`,
    '',
    ...groupTable('Genre Summary', report.groupSummaries.genre),
    ...groupTable('Section Kind Summary', report.groupSummaries.sectionKind),
    ...groupTable('Risk Flag Summary', report.groupSummaries.riskFlags),
    ...groupTable('Mode Summary', report.groupSummaries.mode),
    ...groupTable('Section Source Summary', report.groupSummaries.sectionSource),
    '## Rubric', '',
    '| Check | Status | Result |',
    '|---|---|---|',
    ...rubricRows.map(([check, status, result]) => `| ${check} | ${status} | ${cell(result)} |`),
    '',
    '## Manual Section Review', '',
    '| Scenario | Section | Mode | Source | Status | Notes |',
    '|---|---|---|---|---|---|',
    ...report.sections.map(s => `| ${s.scenarioId} | ${s.ref} ${s.label ? `(${s.label})` : ''} | ${s.mode} | ${s.sectionSource} | ${s.manualReview?.status || 'pending'} | ${s.manualReview?.notes || ''} |`),
    '',
    '## Rendered Verses', '',
  ];
  for (const s of report.sections) {
    lines.push(`### ${s.ref}${s.label ? `, ${s.label}` : ''}`, '');
    lines.push(`Scenario: ${s.scenarioId}; mode=${s.mode}; source=${s.sectionSource}; evalSet=${s.evalSet}`, '');
    for (const e of s.entries) {
      lines.push(`#### ${e.ref}`, '', `Rendering: ${e.rendering}`, '', `Note: ${e.note}`, '');
      lines.push(`Meta: noteKind=${e.noteKind}; christConnection=${e.christConnection}; scenarioId=${e.scenarioId}; mode=${e.mode}; sectionSource=${e.sectionSource}; noteWords=${wordCount(e.note)}; noteChars=${e.note.length}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

function writeEvalReport(report, reportsDir = REPORTS_DIR) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const base = `${report.generatedAt.replace(/[:.]/g, '-')}-${slugify(report.evalName)}`;
  const jsonPath = path.join(reportsDir, `${base}.json`);
  const mdPath = path.join(reportsDir, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, buildMarkdownReport(report));
  return { jsonPath, mdPath };
}

// Release-blocking checks only; subjective review items never fail the gate.
function gateFailures(report) {
  const { rubric } = report;
  const failures = [];
  if (rubric.schemaCompleteness.status !== 'pass') failures.push('schema completeness failed');
  if (rubric.referenceIntegrity.status !== 'pass') failures.push('reference integrity failed');
  if (rubric.emDashRemoval.cleanedRefs.length > 0) failures.push('cleaned output contains em dashes');
  if (rubric.vapourSpelling.cleanedRefs.length > 0) failures.push('cleaned output contains vapor');
  if (rubric.reportMetadata.status !== 'pass') failures.push('report metadata incomplete');
  return failures;
}

async function runEval({ fetchImpl } = {}) {
  if (!RENDER.apiKey) throw new Error('XAI_API_KEY is required for renderer v2 eval.');
  const sections = evalSections(EVAL_SET);
  if (sections.length === 0) throw new Error(`No renderer v2 eval sections found for EVAL_SET=${EVAL_SET}.`);

  const rendered = [];
  for (const section of sections) {
    const entries = await renderSection({
      apiUrl: RENDER.apiUrl,
      apiKey: RENDER.apiKey,
      model: RENDER.model,
      reasoningEffort: RENDER.reasoningEffort,
      timeoutMs: RENDER.sectionTimeoutMs,
      section,
      fetchImpl,
    });
    for (const entry of entries) {
      rendered.push({
        ref: entry.ref,
        sectionRef: sectionRef(section),
        scenarioId: section.scenarioId,
        mode: section.mode,
        sectionSource: section.source,
        evalSet: section.evalSet || EVAL_SET,
        genre: section.genre || null,
        sectionKind: section.sectionKind || null,
        riskFlags: Array.isArray(section.riskFlags) ? section.riskFlags : [],
        rawRendering: entry.rendering,
        rawNote: entry.note,
        rendering: cleanText(entry.rendering),
        note: cleanText(entry.note),
        noteKind: entry.noteKind,
        christConnection: entry.christConnection,
      });
    }
  }
  return buildEvalReport({ evalSet: EVAL_SET, sections, rendered });
}

function printSummary(report, paths) {
  const { config, metrics } = report;
  console.log(`Renderer v2 ${config.evalSet} eval`);
  console.log(`model=${config.model} reasoning=${config.reasoningEffort} prompt=${config.promptVersion} schema=${config.schemaVersion} sections=${config.sectionsVersion} sectionFingerprint=${config.sectionsFingerprint} evalScenarios=${config.evalScenariosVersion}`);
  console.log('');
  for (const e of report.rendered) {
    console.log(e.ref);
    console.log(`  rendering: ${e.rendering}`);
    console.log(`  note: ${e.note}`);
    console.log(`  meta: scenarioId=${e.scenarioId} mode=${e.mode} sectionSource=${e.sectionSource} noteKind=${e.noteKind} christConnection=${e.christConnection} noteWords=${wordCount(e.note)} noteChars=${e.note.length}`);
    console.log('');
  }
  console.log('Metrics');
  console.log(`  verses: ${metrics.verses}`);
  console.log(`  sections: ${metrics.sectionCount}`);
  console.log(`  maxTargetVerses: ${metrics.maxTargetVerses}`);
  console.log(`  sectionSources: ${JSON.stringify(metrics.sectionSources)}`);
  console.log(`  schemaComplete: ${metrics.schemaComplete}`);
  console.log(`  echoNotes: ${metrics.echoNotes}`);
  console.log(`  avgNoteWords: ${metrics.avgNoteWords}`);
  console.log(`  avgNoteChars: ${metrics.avgNoteChars}`);
  console.log(`  repeatedOpenings: ${jsonOrNone(metrics.repeatedOpenings)}`);
  console.log(`  noteKinds: ${JSON.stringify(metrics.noteKinds)}`);
  console.log(`  christConnections: ${JSON.stringify(metrics.christConnections)}`);
  console.log(`  referenceIntegrity: ${report.rubric.referenceIntegrity.status}`);
  console.log('');
  console.log(`Report: ${path.relative(process.cwd(), paths.mdPath)}`);
  console.log(`JSON: ${path.relative(process.cwd(), paths.jsonPath)}`);
}

async function main() {
  const report = await runEval();
  printSummary(report, writeEvalReport(report));
  if (!EVAL_GATE) return;
  const failures = gateFailures(report);
  if (failures.length > 0) {
    console.error(`Renderer v2 gate failed: ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('Renderer v2 gate passed');
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { buildEvalReport, buildMarkdownReport, gateFailures, writeEvalReport };
