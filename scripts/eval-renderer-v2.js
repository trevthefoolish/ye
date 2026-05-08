#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');
const {
  EVAL_SCENARIOS_VERSION,
  SECTIONS_FINGERPRINT,
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  SECTIONS_VERSION,
  evalSections,
  refForEntry,
  renderSectionOnce,
} = require('../rendererV2');

const API_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/responses';
const API_KEY = process.env.XAI_API_KEY;
const MODEL = process.env.RENDER_MODEL || 'grok-4.3';
const REASONING_EFFORT = process.env.RENDER_REASONING_EFFORT || 'none';
const EVAL_SET = process.env.EVAL_SET || 'smoke';
const EVAL_GATE = process.env.EVAL_GATE === '1' || process.env.EVAL_GATE === 'true';
const REPORTS_DIR = process.env.EVAL_REPORTS_DIR || path.join(__dirname, '..', 'eval-reports');

function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/gi, 'vapour');
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function opening(note) {
  return note.replace(/["'()]/g, '').split(/\s+/).slice(0, 4).join(' ').replace(/[,:;.]+$/, '');
}

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sum(items, fn) {
  return items.reduce((total, item) => total + fn(item), 0);
}

function safeSlug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function statusFor(condition, warn = 'warn') {
  return condition ? 'pass' : warn;
}

function sectionRef(section) {
  return `${section.book} ${section.chapter}:${section.start}-${section.end}`;
}

function entryKey(entry) {
  return `${entry.scenarioId || 'unknown'}|${entry.ref}`;
}

function sectionKey(section, verse) {
  return `${section.scenarioId || 'unknown'}|${refForEntry(section.book, section.chapter, verse)}`;
}

function duplicateValues(items, keyFor) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));
}

function incrementCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function summarizeSectionGroups(sections, noteLengthWarningRefs, echoNoteRefs) {
  const groupConfigs = [
    ['genre', section => [section.genre || 'unclassified']],
    ['sectionKind', section => [section.sectionKind || 'unclassified']],
    ['riskFlags', section => (Array.isArray(section.riskFlags) && section.riskFlags.length ? section.riskFlags : ['none'])],
    ['mode', section => [section.mode || 'unknown']],
    ['sectionSource', section => [section.sectionSource || section.source || 'unknown']],
  ];
  const summaries = {};

  for (const [groupName, valuesFor] of groupConfigs) {
    const groups = new Map();
    for (const section of sections) {
      for (const value of valuesFor(section)) {
        if (!groups.has(value)) {
          groups.set(value, {
            value,
            sectionCount: 0,
            verseCount: 0,
            warningCount: 0,
            noteLengthWarnings: 0,
            genericEchoWarnings: 0,
            christConnections: {},
            sections: [],
          });
        }
        const group = groups.get(value);
        group.sectionCount++;
        group.sections.push(section.ref);
        for (const entry of section.entries) {
          group.verseCount++;
          if (noteLengthWarningRefs.has(entry.key)) {
            group.noteLengthWarnings++;
            group.warningCount++;
          }
          if (echoNoteRefs.has(entry.key)) {
            group.genericEchoWarnings++;
            group.warningCount++;
          }
          incrementCount(group.christConnections, entry.christConnection || 'missing');
        }
      }
    }
    summaries[groupName] = [...groups.values()].sort((a, b) => b.warningCount - a.warningCount || b.verseCount - a.verseCount || a.value.localeCompare(b.value));
  }

  return summaries;
}

function expectedRenderedKeys(sections) {
  const expected = new Set();
  for (const section of sections) {
    for (const verse of section.targetVerses || []) {
      expected.add(sectionKey(section, verse));
    }
  }
  return expected;
}

function buildReferenceIntegrity(sections, rendered) {
  const expected = expectedRenderedKeys(sections);
  const actual = new Set(rendered.map(entryKey));
  return {
    expectedCount: expected.size,
    actualCount: actual.size,
    duplicateRenderedRefs: duplicateValues(rendered, entryKey),
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
  const generatedAtIso = generatedAt.toISOString();
  const renderedWithKeys = rendered.map(entry => ({ ...entry, key: entryKey(entry) }));
  const repeatedOpenings = countBy(renderedWithKeys, e => opening(e.note)).filter(([, count]) => count > 1);
  const noteKinds = countBy(renderedWithKeys, e => e.noteKind);
  const christConnections = countBy(renderedWithKeys, e => e.christConnection);
  const completeEntries = renderedWithKeys.filter(e => e.rendering && e.note && e.noteKind && e.christConnection);
  const noteWords = renderedWithKeys.map(e => wordCount(e.note));
  const noteChars = renderedWithKeys.map(e => e.note.length);
  const notesOver18Words = renderedWithKeys.filter(e => wordCount(e.note) > 18);
  const notesLongerThanRendering = renderedWithKeys.filter(e => e.note.length >= e.rendering.length);
  const echoNotes = renderedWithKeys.filter(e => /\becho(?:es|ing|ed)?\b/i.test(e.note));
  const christReviewRefs = renderedWithKeys
    .filter(e => e.christConnection !== 'none')
    .map(e => ({ ref: e.ref, scenarioId: e.scenarioId, christConnection: e.christConnection, note: e.note }));
  const rawEmDashRefs = renderedWithKeys
    .filter(e => (e.rawRendering || '').includes('\u2014') || (e.rawNote || '').includes('\u2014'))
    .map(e => e.ref);
  const cleanedEmDashRefs = renderedWithKeys
    .filter(e => e.rendering.includes('\u2014') || e.note.includes('\u2014'))
    .map(e => e.ref);
  const rawAmericanVaporRefs = renderedWithKeys
    .filter(e => /\bvapor\b/i.test(e.rawRendering || '') || /\bvapor\b/i.test(e.rawNote || ''))
    .map(e => e.ref);
  const cleanedAmericanVaporRefs = renderedWithKeys
    .filter(e => /\bvapor\b/i.test(e.rendering) || /\bvapor\b/i.test(e.note))
    .map(e => e.ref);

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
      targetVerses: section.targetVerses,
      manualReview: {
        status: 'pending',
        notes: '',
      },
      entries: renderedWithKeys.filter(entry => entry.scenarioId === scenarioId && entry.sectionRef === ref),
    };
  });
  const noteLengthWarningKeys = new Set([...notesOver18Words, ...notesLongerThanRendering].map(e => e.key));
  const echoNoteKeys = new Set(echoNotes.map(e => e.key));
  const groupSummaries = summarizeSectionGroups(groupedSections, noteLengthWarningKeys, echoNoteKeys);
  const referenceIntegrity = buildReferenceIntegrity(sections, renderedWithKeys);
  const sectionSources = countBy(groupedSections, section => section.sectionSource);

  const metrics = {
    verses: renderedWithKeys.length,
    schemaComplete: `${completeEntries.length}/${renderedWithKeys.length}`,
    schemaCompleteCount: completeEntries.length,
    echoNotes: echoNotes.length,
    avgNoteWords: noteWords.length ? Math.round(noteWords.reduce((a, b) => a + b, 0) / noteWords.length) : 0,
    avgNoteChars: noteChars.length ? Math.round(noteChars.reduce((a, b) => a + b, 0) / noteChars.length) : 0,
    repeatedOpenings: Object.fromEntries(repeatedOpenings),
    noteKinds: Object.fromEntries(noteKinds),
    christConnections: Object.fromEntries(christConnections),
    rawEmDashCount: sum(renderedWithKeys, e => ((e.rawRendering || '').match(/\u2014/g) || []).length + ((e.rawNote || '').match(/\u2014/g) || []).length),
    cleanedEmDashCount: sum(renderedWithKeys, e => (e.rendering.match(/\u2014/g) || []).length + (e.note.match(/\u2014/g) || []).length),
    rawAmericanVaporCount: sum(renderedWithKeys, e => ((e.rawRendering || '').match(/\bvapor\b/gi) || []).length + ((e.rawNote || '').match(/\bvapor\b/gi) || []).length),
    cleanedAmericanVaporCount: sum(renderedWithKeys, e => (e.rendering.match(/\bvapor\b/gi) || []).length + (e.note.match(/\bvapor\b/gi) || []).length),
    sectionCount: groupedSections.length,
    maxTargetVerses: groupedSections.length ? Math.max(...groupedSections.map(section => section.targetVerses.length)) : 0,
    sectionSources: Object.fromEntries(sectionSources),
    referenceIntegrity,
  };

  const report = {
    evalName: `renderer-v2-${evalSet}`,
    generatedAt: generatedAtIso,
    config: {
      evalSet,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      promptVersion: V2_PROMPT_VERSION,
      schemaVersion: V2_SCHEMA_VERSION,
      sectionsVersion: SECTIONS_VERSION,
      sectionsFingerprint: SECTIONS_FINGERPRINT,
      evalScenariosVersion: EVAL_SCENARIOS_VERSION,
      apiUrl: API_URL,
      gate: EVAL_GATE,
    },
    metrics,
    groupSummaries,
    rubric: {
      schemaCompleteness: {
        status: statusFor(completeEntries.length === renderedWithKeys.length),
        result: metrics.schemaComplete,
        refsNeedingReview: renderedWithKeys.filter(e => !(e.rendering && e.note && e.noteKind && e.christConnection)).map(e => e.ref),
      },
      referenceIntegrity: {
        status: statusFor(
          referenceIntegrity.duplicateRenderedRefs.length === 0
          && referenceIntegrity.missingRenderedRefs.length === 0
          && referenceIntegrity.unexpectedRenderedRefs.length === 0
        ),
        ...referenceIntegrity,
      },
      noteLength: {
        status: statusFor(notesOver18Words.length === 0 && notesLongerThanRendering.length === 0),
        notesOver18Words: notesOver18Words.map(e => e.ref),
        notesLongerThanRendering: notesLongerThanRendering.map(e => e.ref),
      },
      repeatedOpenings: {
        status: statusFor(repeatedOpenings.length === 0),
        openings: Object.fromEntries(repeatedOpenings),
      },
      genericEchoLanguage: {
        status: statusFor(echoNotes.length === 0),
        refs: echoNotes.map(e => e.ref),
      },
      forcedChristConnections: {
        status: christReviewRefs.length ? 'review' : 'pass',
        note: 'Manual review required for non-none Christ connections.',
        refs: christReviewRefs,
      },
      emDashRemoval: {
        status: statusFor(cleanedEmDashRefs.length === 0),
        rawRefs: rawEmDashRefs,
        cleanedRefs: cleanedEmDashRefs,
      },
      vapourSpelling: {
        status: statusFor(cleanedAmericanVaporRefs.length === 0),
        rawRefs: rawAmericanVaporRefs,
        cleanedRefs: cleanedAmericanVaporRefs,
      },
      reportMetadata: {
        status: 'pass',
        missing: [],
      },
      manualSectionReview: {
        status: 'pending',
        sections: groupedSections.map(section => ({
          ref: section.ref,
          scenarioId: section.scenarioId,
          mode: section.mode,
          sectionSource: section.sectionSource,
          label: section.label,
          status: section.manualReview.status,
          notes: section.manualReview.notes,
        })),
      },
    },
    sections: groupedSections,
    rendered: renderedWithKeys,
  };
  report.rubric.reportMetadata.missing = reportMetadataMissing(report);
  report.rubric.reportMetadata.status = statusFor(report.rubric.reportMetadata.missing.length === 0);
  return report;
}

function markdownList(items) {
  if (!items || items.length === 0) return 'none';
  return items.map(item => {
    if (typeof item === 'string') return item;
    if (item.ref && item.christConnection) return `${item.ref} (${item.christConnection})`;
    if (item.key && item.count) return `${item.key} x${item.count}`;
    return JSON.stringify(item);
  }).join(', ');
}

function markdownChristConnections(connections) {
  return Object.keys(connections).length ? JSON.stringify(connections) : 'none';
}

function appendGroupSummary(lines, title, rows) {
  lines.push(`## ${title}`, '');
  lines.push('| Value | Sections | Verses | Warnings | Note length | Generic echo | Christ connections |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const row of rows) {
    lines.push(`| ${row.value} | ${row.sectionCount} | ${row.verseCount} | ${row.warningCount} | ${row.noteLengthWarnings} | ${row.genericEchoWarnings} | ${markdownChristConnections(row.christConnections).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
}

function buildMarkdownReport(report) {
  const rubricRows = [
    ['Schema completeness', report.rubric.schemaCompleteness.status, report.rubric.schemaCompleteness.result],
    ['Reference integrity', report.rubric.referenceIntegrity.status, `duplicates: ${markdownList(report.rubric.referenceIntegrity.duplicateRenderedRefs)}; missing: ${markdownList(report.rubric.referenceIntegrity.missingRenderedRefs)}; unexpected: ${markdownList(report.rubric.referenceIntegrity.unexpectedRenderedRefs)}`],
    ['Note length', report.rubric.noteLength.status, `>18 words: ${markdownList(report.rubric.noteLength.notesOver18Words)}; note >= rendering: ${markdownList(report.rubric.noteLength.notesLongerThanRendering)}`],
    ['Repeated openings', report.rubric.repeatedOpenings.status, Object.keys(report.rubric.repeatedOpenings.openings).length ? JSON.stringify(report.rubric.repeatedOpenings.openings) : 'none'],
    ['Generic echo language', report.rubric.genericEchoLanguage.status, markdownList(report.rubric.genericEchoLanguage.refs)],
    ['Forced Christ connections', report.rubric.forcedChristConnections.status, markdownList(report.rubric.forcedChristConnections.refs)],
    ['Em dash removal', report.rubric.emDashRemoval.status, `raw: ${markdownList(report.rubric.emDashRemoval.rawRefs)}; cleaned: ${markdownList(report.rubric.emDashRemoval.cleanedRefs)}`],
    ['Vapour spelling', report.rubric.vapourSpelling.status, `raw: ${markdownList(report.rubric.vapourSpelling.rawRefs)}; cleaned: ${markdownList(report.rubric.vapourSpelling.cleanedRefs)}`],
    ['Report metadata', report.rubric.reportMetadata.status, markdownList(report.rubric.reportMetadata.missing)],
    ['Manual section review', report.rubric.manualSectionReview.status, 'Fill in pass/fail and notes for each section before merge.'],
  ];

  const lines = [
    `# Renderer v2 ${report.config.evalSet} eval`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Config',
    '',
    `- evalSet: ${report.config.evalSet}`,
    `- model: ${report.config.model}`,
    `- reasoning: ${report.config.reasoningEffort}`,
    `- prompt: ${report.config.promptVersion}`,
    `- schema: ${report.config.schemaVersion}`,
    `- sections: ${report.config.sectionsVersion}`,
    `- sections fingerprint: ${report.config.sectionsFingerprint}`,
    `- eval scenarios: ${report.config.evalScenariosVersion}`,
    `- gate: ${report.config.gate ? 'on' : 'off'}`,
    '',
    '## Metrics',
    '',
    `- verses: ${report.metrics.verses}`,
    `- sections: ${report.metrics.sectionCount}`,
    `- maxTargetVerses: ${report.metrics.maxTargetVerses}`,
    `- sectionSources: ${JSON.stringify(report.metrics.sectionSources)}`,
    `- schemaComplete: ${report.metrics.schemaComplete}`,
    `- echoNotes: ${report.metrics.echoNotes}`,
    `- avgNoteWords: ${report.metrics.avgNoteWords}`,
    `- avgNoteChars: ${report.metrics.avgNoteChars}`,
    `- repeatedOpenings: ${Object.keys(report.metrics.repeatedOpenings).length ? JSON.stringify(report.metrics.repeatedOpenings) : 'none'}`,
    `- noteKinds: ${JSON.stringify(report.metrics.noteKinds)}`,
    `- christConnections: ${JSON.stringify(report.metrics.christConnections)}`,
    '',
  ];

  appendGroupSummary(lines, 'Genre Summary', report.groupSummaries.genre);
  appendGroupSummary(lines, 'Section Kind Summary', report.groupSummaries.sectionKind);
  appendGroupSummary(lines, 'Risk Flag Summary', report.groupSummaries.riskFlags);
  appendGroupSummary(lines, 'Mode Summary', report.groupSummaries.mode);
  appendGroupSummary(lines, 'Section Source Summary', report.groupSummaries.sectionSource);

  lines.push(
    '## Rubric',
    '',
    '| Check | Status | Result |',
    '|---|---|---|',
    ...rubricRows.map(row => `| ${row[0]} | ${row[1]} | ${String(row[2]).replace(/\|/g, '\\|')} |`),
    '',
    '## Manual Section Review',
    '',
    '| Scenario | Section | Mode | Source | Status | Notes |',
    '|---|---|---|---|---|---|',
    ...report.sections.map(section => `| ${section.scenarioId} | ${section.ref} ${section.label ? `(${section.label})` : ''} | ${section.mode} | ${section.sectionSource} | pending |  |`),
    '',
    '## Rendered Verses',
    '',
  );

  for (const section of report.sections) {
    lines.push(`### ${section.ref}${section.label ? `, ${section.label}` : ''}`, '');
    lines.push(`Scenario: ${section.scenarioId}; mode=${section.mode}; source=${section.sectionSource}; evalSet=${section.evalSet}`);
    lines.push('');
    for (const entry of section.entries) {
      lines.push(`#### ${entry.ref}`);
      lines.push('');
      lines.push(`Rendering: ${entry.rendering}`);
      lines.push('');
      lines.push(`Note: ${entry.note}`);
      lines.push('');
      lines.push(`Meta: noteKind=${entry.noteKind}; christConnection=${entry.christConnection}; scenarioId=${entry.scenarioId}; mode=${entry.mode}; sectionSource=${entry.sectionSource}; noteWords=${wordCount(entry.note)}; noteChars=${entry.note.length}`);
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}

function writeEvalReport(report, reportsDir = REPORTS_DIR) {
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const base = `${stamp}-${safeSlug(report.evalName)}`;
  const jsonPath = path.join(reportsDir, `${base}.json`);
  const mdPath = path.join(reportsDir, `${base}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, buildMarkdownReport(report));
  return { jsonPath, mdPath };
}

function gateFailures(report) {
  const failures = [];
  if (report.rubric.schemaCompleteness.status !== 'pass') failures.push('schema completeness failed');
  if (report.rubric.referenceIntegrity.status !== 'pass') failures.push('reference integrity failed');
  if (report.rubric.emDashRemoval.cleanedRefs.length > 0) failures.push('cleaned output contains em dashes');
  if (report.rubric.vapourSpelling.cleanedRefs.length > 0) failures.push('cleaned output contains vapor');
  if (report.rubric.reportMetadata.status !== 'pass') failures.push('report metadata incomplete');
  return failures;
}

async function runEval({ fetchImpl } = {}) {
  if (!API_KEY) {
    throw new Error('XAI_API_KEY is required for renderer v2 eval.');
  }

  const sections = evalSections(EVAL_SET);
  if (sections.length === 0) {
    throw new Error(`No renderer v2 eval sections found for EVAL_SET=${EVAL_SET}.`);
  }
  const rendered = [];

  for (const section of sections) {
    const ref = sectionRef(section);
    const entries = await renderSectionOnce({
      apiUrl: API_URL,
      apiKey: API_KEY,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      bookName: section.book,
      chapter: section.chapter,
      section,
      fetchImpl,
    });
    for (const entry of entries) {
      const rawRendering = entry.rendering;
      const rawNote = entry.note;
      rendered.push({
        ref: refForEntry(section.book, section.chapter, entry.verse),
        sectionRef: ref,
        scenarioId: section.scenarioId,
        mode: section.mode,
        sectionSource: section.source,
        evalSet: section.evalSet || EVAL_SET,
        genre: section.genre || null,
        sectionKind: section.sectionKind || null,
        riskFlags: Array.isArray(section.riskFlags) ? section.riskFlags : [],
        rawRendering,
        rawNote,
        rendering: cleanText(entry.rendering),
        note: cleanText(entry.note),
        noteKind: entry.noteKind,
        christConnection: entry.christConnection,
      });
    }
  }

  return buildEvalReport({ evalSet: EVAL_SET, sections, rendered });
}

function printEvalReportSummary(report, reportPaths) {
  console.log(`Renderer v2 ${report.config.evalSet} eval`);
  console.log(`model=${report.config.model} reasoning=${report.config.reasoningEffort} prompt=${V2_PROMPT_VERSION} schema=${V2_SCHEMA_VERSION} sections=${SECTIONS_VERSION} sectionFingerprint=${SECTIONS_FINGERPRINT} evalScenarios=${EVAL_SCENARIOS_VERSION}`);
  console.log('');

  for (const entry of report.rendered) {
    console.log(`${entry.ref}`);
    console.log(`  rendering: ${entry.rendering}`);
    console.log(`  note: ${entry.note}`);
    console.log(`  meta: scenarioId=${entry.scenarioId} mode=${entry.mode} sectionSource=${entry.sectionSource} noteKind=${entry.noteKind} christConnection=${entry.christConnection} noteWords=${wordCount(entry.note)} noteChars=${entry.note.length}`);
    console.log('');
  }

  console.log('Metrics');
  console.log(`  verses: ${report.metrics.verses}`);
  console.log(`  sections: ${report.metrics.sectionCount}`);
  console.log(`  maxTargetVerses: ${report.metrics.maxTargetVerses}`);
  console.log(`  sectionSources: ${JSON.stringify(report.metrics.sectionSources)}`);
  console.log(`  schemaComplete: ${report.metrics.schemaComplete}`);
  console.log(`  echoNotes: ${report.metrics.echoNotes}`);
  console.log(`  avgNoteWords: ${report.metrics.avgNoteWords}`);
  console.log(`  avgNoteChars: ${report.metrics.avgNoteChars}`);
  console.log(`  repeatedOpenings: ${Object.keys(report.metrics.repeatedOpenings).length ? JSON.stringify(report.metrics.repeatedOpenings) : 'none'}`);
  console.log(`  noteKinds: ${JSON.stringify(report.metrics.noteKinds)}`);
  console.log(`  christConnections: ${JSON.stringify(report.metrics.christConnections)}`);
  console.log(`  referenceIntegrity: ${report.rubric.referenceIntegrity.status}`);
  console.log('');
  console.log(`Report: ${path.relative(process.cwd(), reportPaths.mdPath)}`);
  console.log(`JSON: ${path.relative(process.cwd(), reportPaths.jsonPath)}`);
}

async function main() {
  const report = await runEval();
  const reportPaths = writeEvalReport(report);
  printEvalReportSummary(report, reportPaths);

  if (EVAL_GATE) {
    const failures = gateFailures(report);
    if (failures.length > 0) {
      console.error(`Renderer v2 gate failed: ${failures.join('; ')}`);
      process.exit(1);
    }
    console.log('Renderer v2 gate passed');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = {
  buildEvalReport,
  buildMarkdownReport,
  cleanText,
  countBy,
  expectedRenderedKeys,
  gateFailures,
  opening,
  runEval,
  safeSlug,
  wordCount,
  writeEvalReport,
};
