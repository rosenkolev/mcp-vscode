'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const { describe, it } = require('node:test');

const FILE = 'a/edit.js';

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('editing', { timeout: 90000 }, () => {
    const readFixture = () => fs.readFile(live.file('a', 'edit.js'), 'utf8');

    it('renames a symbol everywhere and saves', async () => {
      assert.match(await live.client.ok('rename_symbol', { path: FILE, line: 3, symbol: 'oldName', new_name: 'newName' }), /Changed 1 file, saved/);
      const text = await readFixture();
      assert.equal(text.match(/newName/g)?.length, 2);
      assert.doesNotMatch(text, /oldName/);
    });

    it('lists code actions and applies one, which edits the file', async () => {
      const listed = await live.client.ok('code_actions', { path: FILE, line: 11, kind: 'refactor.extract' });
      assert.match(listed, /1\. Extract to constant/);
      const applied = await live.client.ok('code_actions', { path: FILE, line: 11, kind: 'refactor.extract', apply: 1, save: false });
      assert.match(applied, /Applied "Extract to constant[^"]*"\. Changed 1 file, unsaved/);
      assert.match(await live.client.ok('list_tabs'), /a\/edit\.js \(unsaved\)/);
    });

    it('keeps a tab with unsaved changes open unless asked to save', async () => {
      assert.match(await live.client.fails('close_tab', { path: FILE }), /unsaved changes/);
      assert.match(await live.client.ok('close_tab', { path: FILE, save: true }), /after saving/);
      assert.match(await readFixture(), /const newLocal = /);
    });

    it('formats a file with the configured formatter', async () => {
      assert.match(await live.client.ok('format_document', { path: FILE }), /Changed 1 file, saved/);
      assert.match(await readFixture(), /function useIt\(x\) \{/);
      assert.match(await live.client.ok('save_files'), /No unsaved files/);
    });
  });
