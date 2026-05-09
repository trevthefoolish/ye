const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const {
  buildEvalReport,
  buildMarkdownReport,
  cleanText,
  gateFailures,
  writeEvalReport,
} = require('../scripts/eval-renderer-v2');
const sectionsData = require('../data/sections.json');
const {
  SECTIONS_FINGERPRINT,
  buildSectionUserPayload,
  evalScenarios,
  evalSections,
  fingerprintSectionMap,
  groupMissingVersesIntoSections,
  renderVersionParts,
  sectionRef,
  validateEvalScenarioData,
  validateSectionMap,
  validateSectionResult,
} = require('../rendererV2');

const ROOT = path.resolve(__dirname, '..');

function validScenario(overrides = {}) {
  return {
    id: 'valid',
    evalSets: ['smoke'],
    mode: 'explicit',
    book: 'Genesis',
    chapter: 1,
    start: 1,
    end: 2,
    label: 'Valid scenario',
    ...overrides,
  };
}

function startMockResponsesXai(t) {
  const payloads = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      payloads.push(payload);
      const user = payload.input.find(m => m.role === 'user');
      const request = JSON.parse(user.content);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'resp_eval_test',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: JSON.stringify({
              verses: request.targetReferences.map(ref => ({
                ref,
                rendering: `Rendered ${ref}`,
                note: `Margin ${ref}`,
                noteKind: 'literary',
                christConnection: 'none',
              })),
            }),
          }],
        }],
      }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1/responses`,
        payloads,
      });
    });
  });
}

function spawnEvalScript(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/eval-renderer-v2.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`eval exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function renderDirSnapshot() {
  const dir = path.join(ROOT, 'renders');
  return Object.fromEntries(fs.readdirSync(dir).sort().map(file => {
    const stat = fs.statSync(path.join(dir, file));
    return [file, { size: stat.size, mtimeMs: stat.mtimeMs }];
  }));
}

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
  assert.equal(
    fingerprintSectionMap({ ...sectionsData, generatedAt: '2000-01-01T00:00:00.000Z' }),
    fingerprintSectionMap({ ...sectionsData, generatedAt: '2030-01-01T00:00:00.000Z' })
  );
});

test('renderer v2 committed section map covers every verse with deterministic fallback sections', () => {
  const validation = validateSectionMap(sectionsData);
  const fallbackSections = sectionsData.sections.filter(section => section.source === 'generated-fallback');

  assert.equal(validation.verses, 31071);
  assert.equal(validation.expectedVerses, 31071);
  assert.deepEqual(validation.missingRefs, []);
  assert.ok(validation.sourceCounts['openbible-consensus'] > 0);
  assert.ok(validation.sourceCounts['generated-fallback'] > 0);
  assert.ok(fallbackSections.length > 0);
  for (const section of fallbackSections) {
    const first = section.references[0];
    const max = first.startsWith('Psalms ') ? 24 : first.startsWith('Proverbs ') ? 8 : 16;
    assert.ok(section.references.length <= max, `${section.id} exceeds fallback max`);
    assert.match(section.id, /^fallback-[a-z0-9-]+-\d+-\d+-\d+-\d+$/);
  }
});

test('renderer v2 eval sets select smoke and edge sections from metadata', () => {
  const smoke = evalSections('smoke');
  const edge = evalSections('edge');
  const prodSim = evalSections('prod-sim');
  const verseCount = sections => sections.reduce((total, section) => total + section.targetReferences.length, 0);

  assert.equal(evalScenarios('smoke').length, 4);
  assert.equal(evalScenarios('edge').length, 24);
  assert.equal(evalScenarios('prod-sim').length, 7);
  assert.equal(smoke.length, 4);
  assert.equal(verseCount(smoke), 15);
  assert.equal(edge.length, 24);
  assert.equal(verseCount(edge), 171);
  assert.ok(prodSim.length > 25);
  assert.ok(verseCount(prodSim) > 300);
  assert.ok(edge.every(section => section.evalSet === 'edge'));
  assert.ok(edge.some(section => section.genre === 'apocalyptic'));
  assert.ok(edge.some(section => section.riskFlags.includes('hard_text')));
  assert.ok(edge.some(section => section.riskFlags.includes('theological_tension')));
  assert.ok(prodSim.some(section => section.source === 'openbible-consensus'));
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
  assert.equal(payload.mode, undefined);
  assert.equal(payload.scenarioId, undefined);
  assert.equal(payload.section.genre, undefined);
  assert.equal(payload.section.sectionKind, undefined);
  assert.equal(payload.targetVerses, undefined);
  assert.deepEqual(payload.targetReferences, ['Joshua 6:20', 'Joshua 6:21']);
});

test('renderer v2 filters extra in-section verses from sparse fallback output', () => {
  const section = {
    book: 'Psalms',
    chapter: 119,
    start: 25,
    end: 48,
    references: Array.from({ length: 24 }, (_, i) => `Psalms 119:${25 + i}`),
    targetReferences: ['Psalms 119:25', 'Psalms 119:48'],
  };
  const verse = n => ({
    ref: `Psalms 119:${n}`,
    rendering: `Rendered ${n}`,
    note: `Note ${n}`,
    noteKind: 'literary',
    christConnection: 'none',
  });

  assert.deepEqual(validateSectionResult({ verses: [verse(25), verse(26), verse(48)] }, section), [verse(25), verse(48)]);
  assert.throws(
    () => validateSectionResult({ verses: [verse(25), verse(49), verse(48)] }, section),
    /unexpected rendered ref/
  );
  assert.throws(
    () => validateSectionResult({ verses: [verse(25), verse(26)] }, section),
    /missing target refs/
  );
});

test('renderer v2 eval scenario loader validates structural errors', () => {
  assert.equal(validateEvalScenarioData({ version: 'test', scenarios: [validScenario()] }), true);
  assert.throws(
    () => validateEvalScenarioData({ version: 'test', scenarios: [validScenario({ book: 'Nope' })] }),
    /unknown book/
  );
  assert.throws(
    () => validateEvalScenarioData({ version: 'test', scenarios: [validScenario({ start: 0 })] }),
    /invalid range/
  );
  assert.throws(
    () => validateEvalScenarioData({ version: 'test', scenarios: [validScenario({ mode: 'bad' })] }),
    /invalid mode/
  );
  assert.throws(
    () => validateEvalScenarioData({ version: 'test', scenarios: [validScenario(), validScenario()] }),
    /duplicate eval scenario id/
  );
  assert.throws(
    () => validateEvalScenarioData({ version: 'test', scenarios: [validScenario({ evalSets: [] })] }),
    /at least one eval set/
  );
});

test('renderer v2 prod-sim scenarios hydrate through production section grouping', () => {
  const prodSim = evalSections('prod-sim');
  const psalm119 = prodSim.filter(section => section.scenarioId === 'prod_psalm_119_full_fallback');
  const expectedPsalm119 = groupMissingVersesIntoSections('Psalms', 119, Array.from({ length: 176 }, (_, i) => i));

  assert.deepEqual(
    psalm119.map(section => [section.id, section.source, section.targetReferences.length]),
    expectedPsalm119.map(section => [section.id, section.source, section.targetReferences.length])
  );
  assert.equal(Math.max(...psalm119.map(section => section.targetReferences.length)), 8);

  const proverbs = prodSim.filter(section => section.scenarioId === 'prod_proverbs_26_partial_crossing');
  assert.deepEqual(proverbs.map(section => [sectionRef(section), section.source, section.targetReferences.length]), [
    ['Proverbs 26:1-Proverbs 26:28', 'openbible-consensus', 28],
  ]);
});

test('renderer v2 eval report writes markdown and JSON rubric artifacts', t => {
  assert.equal(cleanText('vapor and vapors'), 'vapour and vapours');

  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-eval-report-'));
  t.after(() => fs.rmSync(reportsDir, { recursive: true, force: true }));

  const sections = [{
    book: 'Genesis',
    chapter: 1,
    start: 1,
    end: 2,
    label: 'Creation begins',
    scenarioId: 'test_creation',
    scenarioLabel: 'Creation begins',
    mode: 'explicit',
    source: 'explicit',
    genre: 'narrative',
    sectionKind: 'creation',
    riskFlags: ['christ_connection_risk'],
    evalSet: 'smoke',
    evalSets: ['smoke'],
    startRef: 'Genesis 1:1',
    endRef: 'Genesis 1:2',
    references: ['Genesis 1:1', 'Genesis 1:2'],
    targetReferences: ['Genesis 1:1', 'Genesis 1:2'],
  }];
  const rendered = [
    {
      ref: 'Genesis 1:1',
      sectionRef: 'Genesis 1:1-Genesis 1:2',
      scenarioId: 'test_creation',
      mode: 'explicit',
      sectionSource: 'explicit',
      evalSet: 'smoke',
      riskFlags: ['christ_connection_risk'],
      rawRendering: 'In the beginning God created the heavens and the earth.',
      rawNote: 'vapor\u2014the opening word points to beginning.',
      rendering: 'In the beginning God created the heavens and the earth.',
      note: 'vapour, the opening word points to beginning.',
      noteKind: 'lexical',
      christConnection: 'none',
    },
    {
      ref: 'Genesis 1:2',
      sectionRef: 'Genesis 1:1-Genesis 1:2',
      scenarioId: 'test_creation',
      mode: 'explicit',
      sectionSource: 'explicit',
      evalSet: 'smoke',
      riskFlags: ['christ_connection_risk'],
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
  assert.equal(report.groupSummaries.mode[0].value, 'explicit');
  assert.equal(report.groupSummaries.sectionSource[0].value, 'explicit');
  assert.equal(report.rubric.genericEchoLanguage.status, 'warn');
  assert.deepEqual(report.rubric.emDashRemoval.rawRefs, ['Genesis 1:1']);
  assert.deepEqual(report.rubric.emDashRemoval.cleanedRefs, []);
  assert.deepEqual(report.rubric.vapourSpelling.cleanedRefs, []);
  assert.equal(report.rubric.forcedChristConnections.status, 'review');
  assert.equal(report.rubric.referenceIntegrity.status, 'pass');
  assert.equal(report.rubric.reportMetadata.status, 'pass');
  assert.match(markdown, /Genre Summary/);
  assert.match(markdown, /Mode Summary/);
  assert.match(markdown, /Section Source Summary/);
  assert.match(markdown, /Risk Flag Summary/);
  assert.match(markdown, /christ_connection_risk/);
  assert.match(markdown, /Manual Section Review/);
  assert.match(markdown, /test_creation/);
  assert.match(markdown, /Genesis 1:1-Genesis 1:2/);
  assert.ok(fs.existsSync(paths.mdPath));
  assert.ok(fs.existsSync(paths.jsonPath));
  assert.equal(JSON.parse(fs.readFileSync(paths.jsonPath, 'utf8')).evalName, 'renderer-v2-smoke');
});

test('renderer v2 eval gate ignores subjective review warnings and fails hard gates only', () => {
  const section = {
    book: 'Genesis',
    chapter: 1,
    start: 1,
    end: 1,
    label: 'Creation begins',
    scenarioId: 'test_gate',
    mode: 'explicit',
    source: 'explicit',
    genre: 'narrative',
    sectionKind: 'creation',
    riskFlags: [],
    evalSet: 'smoke',
    evalSets: ['smoke'],
    startRef: 'Genesis 1:1',
    endRef: 'Genesis 1:1',
    references: ['Genesis 1:1'],
    targetReferences: ['Genesis 1:1'],
  };
  const rendered = [{
    ref: 'Genesis 1:1',
    sectionRef: 'Genesis 1:1-Genesis 1:1',
    scenarioId: 'test_gate',
    mode: 'explicit',
    sectionSource: 'explicit',
    evalSet: 'smoke',
    riskFlags: [],
    rawRendering: 'In the beginning God created the heavens and the earth.',
    rawNote: 'Christ connection requires manual review.',
    rendering: 'In the beginning God created the heavens and the earth.',
    note: 'Christ connection requires manual review.',
    noteKind: 'christ_pattern',
    christConnection: 'typological',
  }];

  const report = buildEvalReport({
    generatedAt: new Date('2026-05-08T20:00:00.000Z'),
    sections: [section],
    rendered,
  });
  assert.equal(report.rubric.forcedChristConnections.status, 'review');
  assert.deepEqual(gateFailures(report), []);

  const badReport = buildEvalReport({
    generatedAt: new Date('2026-05-08T20:00:00.000Z'),
    sections: [section],
    rendered: [{
      ...rendered[0],
      rawNote: 'Bad dash.',
      note: 'Bad \u2014 dash.',
    }],
  });
  assert.ok(gateFailures(badReport).some(failure => failure.includes('em dashes')));
});

test('renderer v2 eval commands use Responses API shape and never write render cache', async t => {
  const mockXai = await startMockResponsesXai(t);
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ye-eval-script-'));
  t.after(() => fs.rmSync(reportsDir, { recursive: true, force: true }));
  const before = renderDirSnapshot();

  for (const evalSet of ['smoke', 'edge', 'prod-sim']) {
    const setReportsDir = path.join(reportsDir, evalSet);
    fs.mkdirSync(setReportsDir);
    await spawnEvalScript({
      XAI_API_KEY: 'test-key',
      XAI_API_URL: mockXai.url,
      EVAL_SET: evalSet,
      EVAL_REPORTS_DIR: setReportsDir,
      RENDER_PIPELINE: 'section-v2',
    });
    const jsonReports = fs.readdirSync(setReportsDir).filter(file => file.endsWith('.json'));
    assert.equal(jsonReports.length, 1);
    const report = JSON.parse(fs.readFileSync(path.join(setReportsDir, jsonReports[0]), 'utf8'));
    assert.equal(report.config.evalSet, evalSet);
    assert.equal(report.rubric.schemaCompleteness.status, 'pass');
    assert.equal(report.rubric.referenceIntegrity.status, 'pass');
  }

  assert.deepEqual(renderDirSnapshot(), before);
  assert.ok(mockXai.payloads.length > 0);
  assert.ok(mockXai.payloads.every(payload => payload.store === false));
  assert.ok(mockXai.payloads.every(payload => payload.messages === undefined));
  assert.ok(mockXai.payloads.every(payload => payload.text.format.name === 'section_rendering'));
  assert.ok(mockXai.payloads.every(payload => Array.isArray(payload.input)));
});
