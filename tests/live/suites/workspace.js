'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('workspace and tabs', () => {
    it('describes the multi-root workspace', async () => {
      const text = await live.client.ok('get_workspace');
      assert.match(text, /multi-root workspace/);
      assert.match(text, /Folders \(2\):\n\s+a - .*\n\s+b - /);
    });

    it('opens a file at a line and reports the cursor', async () => {
      assert.match(await live.client.ok('open_file', { path: 'a/calc.js', line: 8, column: 3 }), /Opened a\/calc\.js at line 8/);
      assert.match(await live.client.ok('get_selection'), /a\/calc\.js\nCursor at 8:3, nothing selected/);
      assert.match(await live.client.ok('list_tabs'), /Active editor: a\/calc\.js:8:3[\s\S]*\* a\/calc\.js/);
    });

    it('refuses to open a folder or a missing file', async () => {
      assert.match(await live.client.fails('open_file', { path: 'b' }), /is a folder/);
      assert.match(await live.client.fails('open_file', { path: 'a/missing.js' }), /No file at/);
    });

    it('closes the tab of a file', async () => {
      assert.match(await live.client.ok('close_tab', { path: 'a/calc.js' }), /Closed 1 tab of a\/calc\.js/);
      assert.match(await live.client.fails('close_tab', { path: 'a/calc.js' }), /No open tab shows/);
    });
  });
