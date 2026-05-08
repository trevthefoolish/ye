#!/usr/bin/env node
// Copyright (c) 2026 vapourware.ai All rights reserved.
const fs = require('fs');
const path = require('path');
const {
  SECTIONS_FINGERPRINT,
  V2_PROMPT_VERSION,
  V2_SCHEMA_VERSION,
  SECTIONS_VERSION,
  evalSections,
  renderSectionOnce,
} = require('../rendererV2');

const API_URL = process.env.XAI_API_URL || 'https://api.x.ai/v1/responses';
const API_KEY = process.env.XAI_API_KEY;
const MODEL = process.env.RENDER_MODEL || 'grok-4.3';
const REASONING_EFFORT = process.env.RENDER_REASONING_EFFORT || 'none';
const EVAL_SET = process.env.EVAL_SET || 'smoke';
const REPORTS_DIR = process.env.EVAL_REPORTS_DIR || path.join(__dirname, '..', 'eval-reports');

function cleanText(s) {
  return s.replaceAll('\u2014', ', ').replace(/\bvapor\b/g, 'vapour');
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

function incrementCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function summarizeSectionGroups(sections, noteLengthWarningRefs, echoNoteRefs) {
  const groupConfigs = [
    ['genre', section => [section.genre || 'unclassified']],
    ['sectionKind', section => [section.sectionKind || 'unclassified']],
    ['riskFlags', section => (Array.isArray(section.riskFlags) && section.riskFlags.length ? section.riskFlags : ['none'])],
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
          if (noteLengthWarningRefs.has(entry.ref)) {
            group.noteLengthWarnings++;
            group.warningCount++;
          }
          if (echoNoteRefs.has(entry.ref)) {
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

function buildEvalReport({ generatedAt = new Date(), evalSet = EVAL_SET, sections, rendered }) {
  const generatedAtIso = generatedAt.toISOString();
  const repeatedOpenings = countBy(rendered, e => opening(e.note)).filter(([, count]) => count > 1);
  const noteKinds = countBy(rendered, e => e.noteKind);
  const christConnections = countBy(rendered, e => e.christConnection);
  const completeEntries = rendered.filter(e => e.rendering && e.note && e.noteKind && e.christConnection);
  const noteWords = rendered.map(e => wordCount(e.note));
  const noteChars = rendered.map(e => e.note.length);
  const notesOver18Words = rendered.filter(e => wordCount(e.note) > 18).map(e => e.ref);
  const notesLongerThanRendering = rendered.filter(e => e.note.length >= e.rendering.length).map(e => e.ref);
  const echoNotes = rendered.filter(e => /\becho(?:es|ing|ed)?\b/i.test(e.note)).map(e => e.ref);
  const christReviewRefs = rendered
    .filter(e => e.christConnection !== 'none')
    .map(e => ({ ref: e.ref, christConnection: e.christConnection, note: e.note }));
  const rawEmDashRefs = rendered
    .filter(e => (e.rawRendering || '').includes('\u2014') || (e.rawNote || '').includes('\u2014'))
    .map(e => e.ref);
  const cleanedEmDashRefs = rendered
    .filter(e => e.rendering.includes('\u2014') || e.note.includes('\u2014'))
    .map(e => e.ref);
  const rawAmericanVaporRefs = rendered
    .filter(e => /\bvapor\b/i.test(e.rawRendering || '') || /\bvapor\b/i.test(e.rawNote || ''))
    .map(e => e.ref);
  const cleanedAmericanVaporRefs = rendered
    .filter(e => /\bvapor\b/i.test(e.rendering) || /\bvapor\b/i.test(e.note))
    .map(e => e.ref);

  const groupedSections = sections.map(section => ({
    ref: sectionRef(section),
    label: section.label,
    source: section.source,
    genre: section.genre || null,
    sectionKind: section.sectionKind || null,
    riskFlags: Array.isArray(section.riskFlags) ? section.riskFlags : [],
    evalSets: Array.isArray(section.evalSets) ? section.evalSets : [],
    targetVerses: section.targetVerses,
    manualReview: {
      status: 'pending',
      notes: '',
    },
    entries: rendered.filter(entry => entry.sectionRef === sectionRef(section)),
  }));
  const noteLengthWarningRefs = new Set([...notesOver18Words, ...notesLongerThanRendering]);
  const echoNoteRefs = new Set(echoNotes);
  const groupSummaries = summarizeSectionGroups(groupedSections, noteLengthWarningRefs, echoNoteRefs);

  const metrics = {
    verses: rendered.length,
    schemaComplete: `${completeEntries.length}/${rendered.length}`,
    schemaCompleteCount: completeEntries.length,
    echoNotes: echoNotes.length,
    avgNoteWords: noteWords.length ? Math.round(noteWords.reduce((a, b) => a + b, 0) / noteWords.length) : 0,
    avgNoteChars: noteChars.length ? Math.round(noteChars.reduce((a, b) => a + b, 0) / noteChars.length) : 0,
    repeatedOpenings: Object.fromEntries(repeatedOpenings),
    noteKinds: Object.fromEntries(noteKinds),
    christConnections: Object.fromEntries(christConnections),
    rawEmDashCount: sum(rendered, e => ((e.rawRendering || '').match(/\u2014/g) || []).length + ((e.rawNote || '').match(/\u2014/g) || []).length),
    cleanedEmDashCount: sum(rendered, e => (e.rendering.match(/\u2014/g) || []).length + (e.note.match(/\u2014/g) || []).length),
    rawAmericanVaporCount: sum(rendered, e => ((e.rawRendering || '').match(/\bvapor\b/gi) || []).length + ((e.rawNote || '').match(/\bvapor\b/gi) || []).length),
    cleanedAmericanVaporCount: sum(rendered, e => (e.rendering.match(/\bvapor\b/gi) || []).length + (e.note.match(/\bvapor\b/gi) || []).length),
  };

  return {
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
      apiUrl: API_URL,
    },
    metrics,
    groupSummaries,
    rubric: {
      schemaCompleteness: {
        status: statusFor(completeEntries.length === rendered.length),
        result: metrics.schemaComplete,
        refsNeedingReview: rendered.filter(e => !(e.rendering && e.note && e.noteKind && e.christConnection)).map(e => e.ref),
      },
      noteLength: {
        status: statusFor(notesOver18Words.length === 0 && notesLongerThanRendering.length === 0),
        notesOver18Words,
        notesLongerThanRendering,
      },
      repeatedOpenings: {
        status: statusFor(repeatedOpenings.length === 0),
        openings: Object.fromEntries(repeatedOpenings),
      },
      genericEchoLanguage: {
        status: statusFor(echoNotes.length === 0),
        refs: echoNotes,
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
      manualSectionReview: {
        status: 'pending',
        sections: groupedSections.map(section => ({
          ref: section.ref,
          label: section.label,
          status: section.manualReview.status,
          notes: section.manualReview.notes,
        })),
      },
    },
    sections: groupedSections,
    rendered,
  };
}

function markdownList(items) {
  if (!items || items.length === 0) return 'none';
  return items.map(item => typeof item === 'string' ? item : `${item.ref} (${item.christConnection})`).join(', ');
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
    ['Note length', report.rubric.noteLength.status, `>18 words: ${markdownList(report.rubric.noteLength.notesOver18Words)}; note >= rendering: ${markdownList(report.rubric.noteLength.notesLongerThanRendering)}`],
    ['Repeated openings', report.rubric.repeatedOpenings.status, Object.keys(report.rubric.repeatedOpenings.openings).length ? JSON.stringify(report.rubric.repeatedOpenings.openings) : 'none'],
    ['Generic echo language', report.rubric.genericEchoLanguage.status, markdownList(report.rubric.genericEchoLanguage.refs)],
    ['Forced Christ connections', report.rubric.forcedChristConnections.status, markdownList(report.rubric.forcedChristConnections.refs)],
    ['Em dash removal', report.rubric.emDashRemoval.status, `raw: ${markdownList(report.rubric.emDashRemoval.rawRefs)}; cleaned: ${markdownList(report.rubric.emDashRemoval.cleanedRefs)}`],
    ['Vapour spelling', report.rubric.vapourSpelling.status, `raw: ${markdownList(report.rubric.vapourSpelling.rawRefs)}; cleaned: ${markdownList(report.rubric.vapourSpelling.cleanedRefs)}`],
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
    '',
    '## Metrics',
    '',
    `- verses: ${report.metrics.verses}`,
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

  lines.push(
    '## Rubric',
    '',
    '| Check | Status | Result |',
    '|---|---|---|',
    ...rubricRows.map(row => `| ${row[0]} | ${row[1]} | ${String(row[2]).replace(/\|/g, '\\|')} |`),
    '',
    '## Manual Section Review',
    '',
    '| Section | Status | Notes |',
    '|---|---|---|',
    ...report.sections.map(section => `| ${section.ref} ${section.label ? `(${section.label})` : ''} | pending |  |`),
    '',
    '## Rendered Verses',
    '',
  );

  for (const section of report.sections) {
    lines.push(`### ${section.ref}${section.label ? `, ${section.label}` : ''}`, '');
    for (const entry of section.entries) {
      lines.push(`#### ${entry.ref}`);
      lines.push('');
      lines.push(`Rendering: ${entry.rendering}`);
      lines.push('');
      lines.push(`Note: ${entry.note}`);
      lines.push('');
      lines.push(`Meta: noteKind=${entry.noteKind}; christConnection=${entry.christConnection}; noteWords=${wordCount(entry.note)}; noteChars=${entry.note.length}`);
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

async function main() {
  if (!API_KEY) {
    console.error('XAI_API_KEY is required for renderer v2 smoke eval.');
    process.exit(1);
  }

  const sections = evalSections(EVAL_SET);
  if (sections.length === 0) {
    console.error(`No renderer v2 eval sections found for EVAL_SET=${EVAL_SET}.`);
    process.exit(1);
  }
  const rendered = [];

  for (const section of sections) {
    const sectionRef = `${section.book} ${section.chapter}:${section.start}-${section.end}`;
    const entries = await renderSectionOnce({
      apiUrl: API_URL,
      apiKey: API_KEY,
      model: MODEL,
      reasoningEffort: REASONING_EFFORT,
      bookName: section.book,
      chapter: section.chapter,
      section,
    });
    for (const entry of entries) {
      const rawRendering = entry.rendering;
      const rawNote = entry.note;
      rendered.push({
        ref: `${section.book} ${section.chapter}:${entry.verse}`,
        sectionRef,
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

  const report = buildEvalReport({ evalSet: EVAL_SET, sections, rendered });
  const reportPaths = writeEvalReport(report);

  console.log(`Renderer v2 ${EVAL_SET} eval`);
  console.log(`model=${MODEL} reasoning=${REASONING_EFFORT} prompt=${V2_PROMPT_VERSION} schema=${V2_SCHEMA_VERSION} sections=${SECTIONS_VERSION} sectionFingerprint=${SECTIONS_FINGERPRINT}`);
  console.log('');

  for (const entry of rendered) {
    console.log(`${entry.ref}`);
    console.log(`  rendering: ${entry.rendering}`);
    console.log(`  note: ${entry.note}`);
    console.log(`  meta: noteKind=${entry.noteKind} christConnection=${entry.christConnection} noteWords=${wordCount(entry.note)} noteChars=${entry.note.length}`);
    console.log('');
  }

  const repeatedOpenings = countBy(rendered, e => opening(e.note)).filter(([, count]) => count > 1);
  const noteKinds = countBy(rendered, e => e.noteKind);
  const christConnections = countBy(rendered, e => e.christConnection);
  const echoCount = rendered.filter(e => /\becho(?:es|ing|ed)?\b/i.test(e.note)).length;
  const completeCount = rendered.filter(e => e.rendering && e.note && e.noteKind && e.christConnection).length;
  const noteWords = rendered.map(e => wordCount(e.note));
  const noteChars = rendered.map(e => e.note.length);

  console.log('Metrics');
  console.log(`  verses: ${rendered.length}`);
  console.log(`  schemaComplete: ${completeCount}/${rendered.length}`);
  console.log(`  echoNotes: ${echoCount}`);
  console.log(`  avgNoteWords: ${Math.round(noteWords.reduce((a, b) => a + b, 0) / noteWords.length)}`);
  console.log(`  avgNoteChars: ${Math.round(noteChars.reduce((a, b) => a + b, 0) / noteChars.length)}`);
  console.log(`  repeatedOpenings: ${repeatedOpenings.length ? JSON.stringify(Object.fromEntries(repeatedOpenings)) : 'none'}`);
  console.log(`  noteKinds: ${JSON.stringify(Object.fromEntries(noteKinds))}`);
  console.log(`  christConnections: ${JSON.stringify(Object.fromEntries(christConnections))}`);
  console.log('');
  console.log(`Report: ${path.relative(process.cwd(), reportPaths.mdPath)}`);
  console.log(`JSON: ${path.relative(process.cwd(), reportPaths.jsonPath)}`);
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
  opening,
  safeSlug,
  wordCount,
  writeEvalReport,
};
