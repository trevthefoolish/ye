const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildEvalReport,
  buildMarkdownReport,
  writeEvalReport,
} = require('../scripts/eval-renderer-v2');
const {
  SECTIONS_FINGERPRINT,
  buildSectionUserPayload,
  evalSections,
  fingerprintSectionMap,
  renderVersionParts,
} = require('../rendererV2');

test('renderer v2 render version includes section map content fingerprint', () => {
  const changedFingerprint = fingerprintSectionMap({
    version: 'sections-v1',
    sections: [
      {
        book: 'Genesis',
        chapter: 1,
        start: 1,
        end: 5,
        label: 'Changed label',
      },
    ],
  });

  assert.notEqual(changedFingerprint, SECTIONS_FINGERPRINT);
  assert.ok(renderVersionParts({ model: 'grok-4.3', reasoningEffort: 'none' }).includes(SECTIONS_FINGERPRINT));
});

test('renderer v2 eval sets select smoke and edge sections from metadata', () => {
  const smoke = evalSections('smoke');
  const edge = evalSections('edge');
  const verseCount = sections => sections.reduce((total, section) => total + section.targetVerses.length, 0);

  assert.equal(smoke.length, 4);
  assert.equal(verseCount(smoke), 15);
  assert.equal(edge.length, 13);
  assert.equal(verseCount(edge), 56);
  assert.ok(edge.every(section => section.evalSets.includes('edge')));
  assert.ok(edge.some(section => section.genre === 'apocalyptic'));
  assert.ok(edge.some(section => section.riskFlags.includes('hard_text')));
});

test('renderer v2 section metadata stays out of the model payload', () => {
  const section = evalSections('edge').find(s => s.book === 'Joshua');
  const payload = buildSectionUserPayload(section.book, section.chapter, section);

  assert.equal(section.genre, 'narrative');
  assert.deepEqual(section.riskFlags, ['violence', 'judgment', 'hard_text']);
  assert.equal(payload.genre, undefined);
  assert.equal(payload.sectionKind, undefined);
  assert.equal(payload.riskFlags, undefined);
  assert.equal(payload.evalSets, undefined);
  assert.equal(payload.section.genre, undefined);
  assert.equal(payload.section.sectionKind, undefined);
  assert.deepEqual(payload.targetVerses, [20, 21]);
});

test('renderer v2 eval report writes markdown and JSON rubric artifacts', t => {
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-eval-report-'));
  t.after(() => fs.rmSync(reportsDir, { recursive: true, force: true }));

  const sections = [{
    book: 'Genesis',
    chapter: 1,
    start: 1,
    end: 2,
    label: 'Creation begins',
    source: 'explicit',
    genre: 'narrative',
    sectionKind: 'creation',
    riskFlags: ['christ_connection_risk'],
    evalSets: ['smoke'],
    targetVerses: [1, 2],
  }];
  const rendered = [
    {
      ref: 'Genesis 1:1',
      sectionRef: 'Genesis 1:1-2',
      rawRendering: 'In the beginning God created the heavens and the earth.',
      rawNote: 'vapor\u2014the opening word points to beginning.',
      rendering: 'In the beginning God created the heavens and the earth.',
      note: 'vapour, the opening word points to beginning.',
      noteKind: 'lexical',
      christConnection: 'none',
    },
    {
      ref: 'Genesis 1:2',
      sectionRef: 'Genesis 1:1-2',
      rawRendering: 'The earth was wild and waste.',
      rawNote: 'This echoes the unformed deep.',
      rendering: 'The earth was wild and waste.',
      note: 'This echoes the unformed deep.',
      noteKind: 'literary',
      christConnection: 'typological',
    },
  ];

  const report = buildEvalReport({
    generatedAt: new Date('2026-05-08T20:00:00.000Z'),
    sections,
    rendered,
  });
  const markdown = buildMarkdownReport(report);
  const paths = writeEvalReport(report, reportsDir);

  assert.equal(report.metrics.schemaComplete, '2/2');
  assert.equal(report.sections[0].genre, 'narrative');
  assert.deepEqual(report.sections[0].riskFlags, ['christ_connection_risk']);
  assert.equal(report.groupSummaries.genre[0].value, 'narrative');
  assert.equal(report.groupSummaries.riskFlags[0].value, 'christ_connection_risk');
  assert.equal(report.rubric.genericEchoLanguage.status, 'warn');
  assert.deepEqual(report.rubric.emDashRemoval.rawRefs, ['Genesis 1:1']);
  assert.deepEqual(report.rubric.emDashRemoval.cleanedRefs, []);
  assert.deepEqual(report.rubric.vapourSpelling.cleanedRefs, []);
  assert.equal(report.rubric.forcedChristConnections.status, 'review');
  assert.match(markdown, /Genre Summary/);
  assert.match(markdown, /Risk Flag Summary/);
  assert.match(markdown, /christ_connection_risk/);
  assert.match(markdown, /Manual Section Review/);
  assert.match(markdown, /Genesis 1:1-2/);
  assert.ok(fs.existsSync(paths.mdPath));
  assert.ok(fs.existsSync(paths.jsonPath));
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).evalName, 'renderer-v2-smoke');
});
