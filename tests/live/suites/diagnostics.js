'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { eventually } = require('../harness/poll');

const DIAGNOSTICS_TIMEOUT_MS = 60000;

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('diagnostics', { timeout: 90000 }, () => {
    it('lists the type error of a checked file once it is open', async () => {
      await live.client.ok('open_file', { path: 'a/checked.js' });
      try {
        const text = await eventually(
          async () => {
            const reply = await live.client.ok('get_diagnostics', { path: 'checked.js', severity: 'error' });
            return /^1 error/.test(reply) && reply;
          },
          DIAGNOSTICS_TIMEOUT_MS,
          'the type error of a/checked.js',
        );
        assert.match(text, /a\/checked\.js:3:7 error \[ts 2322\]/);
      } finally {
        await live.client.call('close_tab', { path: 'a/checked.js' });
      }
    });

    it('validates the severity', async () => {
      assert.match(await live.client.fails('get_diagnostics', { severity: 'bogus' }), /"severity" must be one of/);
    });
  });
