'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { buildEvalReport, buildMarkdownReport, gateFailures, writeEvalReport } = require('../scripts/eval-renderer-v2');
const { ROOT, startMockXai, tempDir } = require('./helpers');

const GENERATED_AT = new Date('2026-05-08T20:00:00.000Z');

function section(overrides = {}) {
  return {
    book: 'Genesis', chapter: 1, start: 1, end: 2, label: 'Creation begins',
    scenarioId: 'test_creation', scenarioLabel: 'Creation begins', mode: 'explicit', source: 'explicit',
    genre: 'narrative', sectionKind: 'creation', riskFlags: ['christ_connection_risk'],
    evalSet: 'smoke', evalSets: ['smoke'],
    startRef: 'Genesis 1:1', endRef: 'Genesis 1:2',
    references: ['Genesis 1:1', 'Genesis 1:2'], targetReferences: ['Genesis 1:1', 'Genesis 1:2'],
    ...overrides,
  };
}

function rendered(ref, overrides = {}) {
  return {
    ref, sectionRef: 'Genesis 1:1-Genesis 1:2', scenarioId: 'test_creation', mode: 'explicit',
    sectionSource: 'explicit', evalSet: 'smoke', riskFlags: ['christ_connection_risk'],
    rawRendering: 'In the beginning God created the heavens and the earth.', rawNote: 'A note.',
    rendering: 'In the beginning God created the heavens and the earth.', note: 'A note.',
    noteKind: 'literary', christConnection: 'none',
    ...overrides,
  };
}

test('eval reports carry grouped summaries and a rubric, as Markdown and JSON', t => {
  const report = buildEvalReport({
    generatedAt: GENERATED_AT,
    evalSet: 'smoke',
    sections: [section()],
    rendered: [
      rendered('Genesis 1:1', { rawNote: 'vapor—the opening word.', note: 'vapour, the opening word.', noteKind: 'lexical' }),
      rendered('Genesis 1:2', { note: 'This echoes the unformed deep.', christConnection: 'typological' }),
    ],
  });
  assert.equal(report.metrics.schemaComplete, '2/2');
  assert.equal(report.sections[0].genre, 'narrative');
  assert.equal(report.groupSummaries.genre[0].value, 'narrative');
  assert.equal(report.groupSummaries.riskFlags[0].value, 'christ_connection_risk');
  assert.equal(report.groupSummaries.sectionSource[0].value, 'explicit');
  assert.equal(report.rubric.genericEchoLanguage.status, 'warn');
  assert.deepEqual(report.rubric.emDashRemoval.rawRefs, ['Genesis 1:1']);
  assert.deepEqual(report.rubric.emDashRemoval.cleanedRefs, []);
  assert.deepEqual(report.rubric.vapourSpelling.rawRefs, ['Genesis 1:1']);
  assert.deepEqual(report.rubric.vapourSpelling.cleanedRefs, []);
  assert.equal(report.rubric.forcedChristConnections.status, 'review');
  assert.equal(report.rubric.referenceIntegrity.status, 'pass');
  assert.equal(report.rubric.reportMetadata.status, 'pass');

  const markdown = buildMarkdownReport(report);
  for (const heading of ['Genre Summary', 'Mode Summary', 'Section Source Summary', 'Risk Flag Summary', 'Manual Section Review']) {
    assert.match(markdown, new RegExp(heading));
  }
  assert.match(markdown, /Genesis 1:1-Genesis 1:2/);

  const paths = writeEvalReport(report, tempDir(t));
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).evalName, 'renderer-v2-smoke');
  assert.ok(fs.existsSync(paths.mdPath));
});

test('the gate fails on structural problems only, never on review items', () => {
  const ok = buildEvalReport({
    generatedAt: GENERATED_AT,
    sections: [section({ end: 1, endRef: 'Genesis 1:1', references: ['Genesis 1:1'], targetReferences: ['Genesis 1:1'] })],
    rendered: [rendered('Genesis 1:1', { sectionRef: 'Genesis 1:1-Genesis 1:1', noteKind: 'christ_pattern', christConnection: 'typological' })],
  });
  assert.equal(ok.rubric.forcedChristConnections.status, 'review');
  assert.deepEqual(gateFailures(ok), []);

  const bad = buildEvalReport({
    generatedAt: GENERATED_AT,
    sections: [section()],
    rendered: [rendered('Genesis 1:1', { note: 'Bad — dash.' }), rendered('Genesis 1:1')],
  });
  const failures = gateFailures(bad);
  assert.ok(failures.includes('cleaned output contains em dashes'));
  assert.ok(failures.includes('reference integrity failed'));
  assert.deepEqual(bad.rubric.referenceIntegrity.duplicateRenderedRefs, [{ key: 'test_creation|Genesis 1:1', count: 2 }]);
  assert.deepEqual(bad.rubric.referenceIntegrity.missingRenderedRefs, ['test_creation|Genesis 1:2']);
});

test('eval runs use the Responses API and never write the render cache', async t => {
  const mock = await startMockXai(t);
  const reportsDir = tempDir(t);
  const rendersDir = path.join(ROOT, 'renders');
  const snapshot = () => fs.readdirSync(rendersDir).map(f => `${f}:${fs.statSync(path.join(rendersDir, f)).mtimeMs}`).join();
  const before = snapshot();

  for (const evalSet of ['smoke', 'edge', 'prod-sim']) {
    const dir = path.join(reportsDir, evalSet);
    await promisify(execFile)(process.execPath, ['scripts/eval-renderer-v2.js'], {
      cwd: ROOT,
      env: { ...process.env, XAI_API_KEY: 'test-key', XAI_API_URL: mock.url, EVAL_SET: evalSet, EVAL_REPORTS_DIR: dir, EVAL_GATE: '1' },
    });
    const [jsonFile] = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const report = JSON.parse(fs.readFileSync(path.join(dir, jsonFile), 'utf8'));
    assert.equal(report.config.evalSet, evalSet);
    assert.equal(report.rubric.schemaCompleteness.status, 'pass');
    assert.equal(report.rubric.referenceIntegrity.status, 'pass');
  }

  assert.equal(snapshot(), before);
  assert.ok(mock.payloads.length > 0);
  for (const payload of mock.payloads) {
    assert.equal(payload.store, false);
    assert.equal(payload.messages, undefined);
    assert.ok(Array.isArray(payload.input));
    assert.equal(payload.text.format.name, 'section_rendering');
  }
});
