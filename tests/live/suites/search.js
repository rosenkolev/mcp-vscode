'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** Folders whose notes.txt matched, from a search_in_files reply. */
async function matchedFolders(live, args) {
  const text = await live.client.ok('search_in_files', { query: 'needle', ...args });
  return [...text.matchAll(/^([ab])\/notes\.txt$/gm)].map((match) => match[1]);
}

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('search', () => {
    it('searches every folder', async () => {
      assert.deepEqual(await matchedFolders(live, {}), ['a', 'b']);
    });

    it('narrows include and exclude to a folder named first', async () => {
      assert.deepEqual(await matchedFolders(live, { include: 'b/**' }), ['b']);
      assert.deepEqual(await matchedFolders(live, { include: 'a' }), ['a']);
      assert.deepEqual(await matchedFolders(live, { exclude: 'b/**' }), ['a']);
      assert.deepEqual(await matchedFolders(live, { include: '**/*.txt', exclude: 'a/notes.txt' }), ['b']);
      assert.deepEqual(await matchedFolders(live, { exclude: '**/notes.txt' }), []);
    });

    it('supports regex, case and whole-word options', async () => {
      assert.match(await live.client.ok('search_in_files', { query: 'need[a-z]+ in', is_regex: true }), /2 matches in 2 files/);
      assert.match(await live.client.ok('search_in_files', { query: 'NEEDLE', case_sensitive: true }), /No matches/);
      assert.match(await live.client.ok('search_in_files', { query: 'need', whole_word: true }), /No matches/);
    });

    it('reports an invalid regex', async () => {
      assert.match(await live.client.fails('search_in_files', { query: '([', is_regex: true }), /not a valid regular expression/);
    });
  });
