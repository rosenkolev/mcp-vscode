'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/**
 * The fixture extension (tests/live/fixture-extension) adds a test controller with three tests in a/calc.js:
 * "adds" passes, "subtracts" fails and "skipped" is skipped.
 * @param {import('../harness/vscode').LiveVsCode} live
 */
module.exports = (live) =>
  describe('test explorer', { timeout: 120000 }, () => {
    it('finds the test controller and the tests of a file', async () => {
      assert.match(await live.client.ok('refresh_tests'), /Controllers with tests: fixture/);
      assert.match(await live.client.ok('test_explorer'), /Test controllers with discovered tests: fixture/);
      // Before any run, the tests are named from their ids.
      const before = await live.client.ok('test_explorer', { file: 'a/calc.js' });
      assert.match(before, /3 tests discovered in a\/calc\.js:/);
      assert.match(before, /adds - not run yet[\s\S]*subtracts - not run yet[\s\S]*skipped - not run yet/);
    });

    it('runs the tests and reports which failed and where', async () => {
      const text = await live.client.ok('run_tests', { scope: 'all', timeout_seconds: 60 });
      assert.match(text, /Test run .*: 1 failed, 1 passed, 1 skipped/);
      assert.match(text, /failed: math > subtracts - a\/calc\.js:7 \(7ms\)/);
      assert.doesNotMatch(text, /passed: math > adds/, 'only failures are listed by default');
      assert.match(text, /Failure messages are not stored by VS Code/);
    });

    it('reads the latest result again, with every test', async () => {
      const text = await live.client.ok('test_results', { show: 'all' });
      assert.match(text, /failed: math > subtracts[\s\S]*passed: math > adds - a\/calc\.js:3 \(5ms\)[\s\S]*skipped: math > skipped/);
    });

    it('lists the discovered tests with their lines and last results once they ran', async () => {
      const text = await live.client.ok('test_explorer', { file: 'a/calc.js' });
      assert.match(text, /math > adds \(line 3\) - last run: passed\n\s+math > subtracts \(line 7\) - last run: failed\n\s+math > skipped \(line 14\) - last run: skipped/);
    });

    it('runs chosen tests by name', async () => {
      const text = await live.client.ok('run_tests', { scope: 'tests', path: 'a/calc.js', names: ['adds', 'math > skipped'], show: 'all', timeout_seconds: 60 });
      assert.match(text, /: 1 passed, 1 skipped/);
      assert.doesNotMatch(text, /subtracts/);
      assert.match(await live.client.fails('run_tests', { scope: 'tests', path: 'a/calc.js', names: ['nope'] }), /No test named "nope"[\s\S]*Discovered: "math > adds"/);
    });

    it('runs the tests of a file and a single test', async () => {
      assert.match(await live.client.ok('run_tests', { scope: 'file', path: 'a/calc.js', timeout_seconds: 60 }), /1 failed, 1 passed, 1 skipped/);
      assert.match(await live.client.ok('run_tests', { scope: 'test', path: 'a/calc.js', line: 3, timeout_seconds: 60 }), /: 1 passed;/);
      assert.match(await live.client.fails('run_tests', { scope: 'test', path: 'a/calc.js' }), /needs "line"/);
      assert.match(await live.client.fails('run_tests', { scope: 'failed', coverage: true }), /cannot collect coverage/);
    });

    it('says when a coverage run collected no coverage', async () => {
      // The fixture controller has no coverage profile.
      assert.match(await live.client.ok('run_tests', { coverage: true, timeout_seconds: 60 }), /No coverage was collected/);
    });

    it('cancels and clears', async () => {
      assert.match(await live.client.ok('cancel_test_run'), /Cancelled/);
      assert.match(await live.client.ok('clear_test_results'), /cleared/);
    });
  });
