'use strict';

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const { describe, it } = require('node:test');
const { eventually, sleep } = require('../harness/poll');

const FILE = 'a/edit.js';

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('editing', { timeout: 90000 }, () => {
    const readFixture = () => fs.readFile(live.file(...FILE.split('/')), 'utf8');

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

    it('replaces exact text and refuses ambiguous or missing text', async () => {
      const edits = [{ old_text: "const label = 'text';", new_text: "const label = 'edited';" }];
      try {
        assert.match(await live.client.ok('edit_file', { path: FILE, edits, show_diff: true }), /Applied 1 edit\. a\/edit\.js is saved\. The diff is open/);
        assert.match(await readFixture(), /const label = 'edited';/);
        assert.match(await live.client.ok('edit_file', { path: FILE, edits: [{ old_text: 'edited', new_text: 'edited' }] }), /No changes/);
        assert.match(await live.client.fails('edit_file', { path: FILE, edits }), /Edit 1: "old_text" is not in the file/);
        assert.match(await live.client.fails('edit_file', { path: FILE, edits: [{ old_text: 'newName', new_text: 'x' }] }), /occurs 2 times/);
      } finally {
        await live.client.call('run_command', { command: 'workbench.action.closeAllEditors' });
      }
    });

    it('keeps an edit unsaved on request, and keeps CRLF line endings', async () => {
      const crlf = live.file('a', 'crlf.txt');
      await fs.writeFile(crlf, 'one\r\ntwo\r\nthree\r\n');
      const edits = [{ old_text: 'one\ntwo', new_text: 'uno\ndos' }];
      assert.match(await live.client.ok('edit_file', { path: 'a/crlf.txt', edits, save: false }), /Applied 1 edit\. a\/crlf\.txt is unsaved/);
      assert.equal(await fs.readFile(crlf, 'utf8'), 'one\r\ntwo\r\nthree\r\n', 'the file on disk is untouched');
      assert.match(await live.client.ok('save_files', { path: 'a/crlf.txt' }), /Saved a\/crlf\.txt/);
      assert.equal(await fs.readFile(crlf, 'utf8'), 'uno\r\ndos\r\nthree\r\n');
    });

    it('lets the user review an edit in the Refactor Preview', async () => {
      const edits = [{ old_text: "'edited'", new_text: "'reviewed'" }];
      let reply;
      const pending = live.client.ok('edit_file', { path: FILE, edits, review: true }).then((text) => (reply = text));
      // The call blocks until the user decides. The preview lists the edits unchecked; the test plays the
      // user through the panel's commands: focus the list, tick the file, which ticks its edits, then Apply.
      await eventually(async () => {
        await sleep(1500);
        for (const command of ['refactorPreview.focus', 'list.focusFirst', 'refactorPreview.toggleCheckedState', 'refactorPreview.apply']) {
          await live.client.call('run_command', { command });
        }
        await sleep(300);
        return reply !== undefined;
      }, 20000, 'the Refactor Preview to apply the edit');
      await pending;
      assert.match(reply, /Applied 1 edit, approved by the user/);
      assert.match(await readFixture(), /const label = 'reviewed';/);
    });

    it('leaves the file unchanged when the user discards a reviewed edit', async () => {
      const before = await readFixture();
      let reply;
      const pending = live.client.ok('edit_file', { path: FILE, edits: [{ old_text: "'reviewed'", new_text: "'discarded'" }], review: true }).then((text) => (reply = text));
      await eventually(async () => {
        await sleep(1500);
        await live.client.call('run_command', { command: 'refactorPreview.discard' });
        await sleep(300);
        return reply !== undefined;
      }, 20000, 'the Refactor Preview to discard the edit');
      await pending;
      assert.match(reply, /The user discarded the edit to a\/edit\.js/);
      assert.equal(await readFixture(), before);
    });

    it('formats a file with the configured formatter', async () => {
      assert.match(await live.client.ok('format_document', { path: FILE }), /Changed 1 file, saved/);
      assert.match(await readFixture(), /function useIt\(x\) \{/);
      assert.match(await live.client.ok('save_files'), /No unsaved files/);
    });
  });
