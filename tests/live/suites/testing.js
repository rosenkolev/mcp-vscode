'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** The isolated profile has no test extension, so these cover the Test Explorer tools without tests. */
/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('test explorer', () => {
    it('reports that no tests are discovered', async () => {
      assert.match(await live.client.ok('test_explorer'), /No tests discovered/);
      assert.match(await live.client.ok('test_explorer', { file: 'a/calc.js' }), /No discovered tests in a\/calc\.js/);
      assert.match(await live.client.ok('refresh_tests'), /Controllers with tests: none/);
      assert.match(await live.client.fails('run_tests'), /No tests discovered/);
    });

    it('cancels and clears without a run', async () => {
      assert.match(await live.client.ok('cancel_test_run'), /Cancelled/);
      assert.match(await live.client.ok('clear_test_results'), /cleared/);
    });
  });
