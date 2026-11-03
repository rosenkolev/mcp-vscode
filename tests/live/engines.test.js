'use strict';

/*
 * Test-engine live tests: test_explorer, run_tests and test_results with real test extensions from the
 * Marketplace, one window per engine. Each project in tests/live/engines has the same three tests in one
 * file: "adds" passes, "subtracts" fails and "skipped" is skipped. The engines are chosen for what they
 * show, not to cover every language: Jest ends an empty run before the real one, Vitest lists a file's
 * tests only after a run, the Node.js test runner reruns whole files and needs no install, and pytest is
 * Python. Needs the network (Marketplace, npm, pip),
 * so it runs only with LIVE_TESTS_NETWORK=1.
 */

const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const { LiveEngine } = require('./harness/engine');
const { eventually } = require('./harness/poll');

const withNetwork = process.env.LIVE_TESTS_NETWORK === '1';
const SETUP_TIMEOUT_MS = 600000;
const DISCOVERY_TIMEOUT_MS = 180000;
const RUN = { timeout_seconds: 300 };

/**
 * The engines: the test file, a line inside the passing test, the passing test's name as its extension
 * reports it, and how each extension differs.
 */
const ENGINES = [
  {
    name: 'jest',
    extension: 'Orta.vscode-jest',
    setup: 'npm',
    // The extension runs tests on save and at start by default; the tests start every run themselves.
    settings: { 'jest.runMode': 'on-demand' },
    file: 'math.test.js',
    passLine: 5,
    passName: 'adds',
  },
  // TypeScript; may list the tests of a file only once the file ran.
  { name: 'vitest', extension: 'vitest.explorer', setup: 'npm', file: 'math.test.ts', passLine: 5, passName: 'adds' },
  // Reruns the whole file of a failed test, and does not report skipped tests.
  { name: 'node', extension: 'connor4312.nodejs-testing', setup: 'none', file: 'math.test.js', passLine: 7, passName: 'adds', rerunsWholeFile: true },
  {
    name: 'pytest',
    extension: 'ms-python.python',
    setup: 'venv',
    settings: { 'python.testing.pytestEnabled': true, 'python.testing.unittestEnabled': false },
    file: 'test_math.py',
    passLine: 7,
    passName: 'test_adds',
  },
];

for (const engine of ENGINES) {
  describe(`test engine: ${engine.name}`, { skip: !withNetwork && 'set LIVE_TESTS_NETWORK=1', timeout: SETUP_TIMEOUT_MS }, () => {
    const live = new LiveEngine(engine);
    const ok = (tool, args) => live.client.ok(tool, args);
    const passed = new RegExp(`passed: .*${engine.passName}`, 'i');
    const failed = /failed: .*subtracts/i;
    // Some extensions (Vitest) may list only the file until it runs.
    const discovered = /\d+ tests? discovered|is in the Test Explorer/;

    before(
      async () => {
        await live.start();
        // Some extensions discover tests only once a test file is open, others only on a refresh.
        await ok('open_file', { path: engine.file });
        await eventually(
          async () => {
            await ok('refresh_tests');
            return discovered.test(await ok('test_explorer', { file: engine.file }));
          },
          DISCOVERY_TIMEOUT_MS,
          `${engine.name} to discover the tests of ${engine.file}`,
        );
      },
      { timeout: SETUP_TIMEOUT_MS },
    );
    after(() => live.stop(), { timeout: 120000 });

    it('runs all tests and reports the failure with its file and line', async () => {
      const text = await ok('run_tests', { scope: 'all', ...RUN });
      assert.match(text, /\b1 failed\b/);
      assert.match(text, /\b1 passed\b/);
      assert.match(text, failed);
      assert.match(text, new RegExp(`${engine.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`));
      assert.match(await ok('test_explorer', { file: engine.file }), /last run: failed/);
    });

    it('runs one file, one test at a line, and tests by name', async () => {
      assert.match(await ok('run_tests', { scope: 'file', path: engine.file, ...RUN }), /\b1 failed\b/);
      for (const args of [
        { scope: 'test', line: engine.passLine },
        { scope: 'tests', names: [engine.passName] },
      ]) {
        const text = await ok('run_tests', { path: engine.file, show: 'all', ...args, ...RUN });
        assert.match(text, passed);
        // Some extensions report the tests they did not run as skipped; none may fail.
        assert.doesNotMatch(text, /failed: /);
      }
    });

    it('reruns the failed tests', async () => {
      await ok('run_tests', { scope: 'all', ...RUN });
      const text = await ok('run_tests', { scope: 'failed', show: 'all', ...RUN });
      assert.match(text, failed);
      if (!engine.rerunsWholeFile) {
        assert.doesNotMatch(text, passed);
      }
    });

    it('runs with coverage', async () => {
      assert.match(await ok('run_tests', { scope: 'all', coverage: true, ...RUN }), /Coverage was collected/);
    });
  });
}
