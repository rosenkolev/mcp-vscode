'use strict';

const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');
const { eventually } = require('../harness/poll');

const LANGUAGE_SERVER_TIMEOUT_MS = 60000;
const FILE = 'a/calc.js';
const SHAPES = 'a/shapes.js';

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('language server tools', { timeout: 120000 }, () => {
    before(async () => {
      // The TypeScript server starts on demand; wait until it answers for the fixture.
      await eventually(
        async () => /addNumbers \(Function\)/.test(await live.client.ok('document_symbols', { path: FILE })),
        LANGUAGE_SERVER_TIMEOUT_MS,
        'the TypeScript server',
      );
      await eventually(
        async () => /Shape \(Class\)/.test(await live.client.ok('document_symbols', { path: SHAPES })),
        LANGUAGE_SERVER_TIMEOUT_MS,
        'the TypeScript server to load a/shapes.js',
      );
    });

    it('outlines a file', async () => {
      const text = await live.client.ok('document_symbols', { path: FILE });
      assert.match(text, /addNumbers \(Function\) lines 3-5/);
      assert.match(text, /total \(Function\) lines 7-13/);
    });

    it('finds the definition and the references of a symbol', async () => {
      assert.match(await live.client.ok('find_definition', { path: FILE, line: 10, symbol: 'addNumbers' }), /a\/calc\.js:3:10\s+function addNumbers/);
      assert.match(await live.client.ok('find_references', { path: FILE, line: 3, symbol: 'addNumbers' }), /^2 references:/);
    });

    it('returns hover information', async () => {
      assert.match(await live.client.ok('get_hover', { path: FILE, line: 7, symbol: 'total' }), /function total\(items: any\): number/);
    });

    it('lists callers and callees', async () => {
      const callers = await live.client.ok('call_hierarchy', { path: FILE, line: 3, symbol: 'addNumbers', direction: 'incoming' });
      assert.match(callers, /Callers of addNumbers[\s\S]*total \(Function\)/);
      const callees = await live.client.ok('call_hierarchy', { path: FILE, line: 7, symbol: 'total', direction: 'outgoing' });
      assert.match(callees, /Calls made by total[\s\S]*addNumbers \(Function\)/);
    });

    it('finds symbols across the workspace', async () => {
      assert.match(await live.client.ok('workspace_symbols', { query: 'addNumbers' }), /addNumbers.*a\/calc\.js:3/);
    });

    it('answers type hierarchy without a provider', async () => {
      // VS Code's built-in TypeScript and JavaScript support has no type hierarchy provider; Java, C# and C++ extensions do.
      const text = await live.client.ok('type_hierarchy', { path: SHAPES, line: 14, symbol: 'Square' });
      assert.match(text, /No class or interface at a\/shapes\.js:14:7/);
    });

    it('returns the signature and the current parameter inside a call', async () => {
      const text = await live.client.ok('signature_help', { path: SHAPES, line: 22, symbol: 'scale(3, ' });
      assert.match(text, /\* scale\(factor: number, unit: string\)/);
      assert.match(text, /current parameter: unit: string - unit of the result/);
    });

    it('lists completions after a member access, filtered', async () => {
      const text = await live.client.ok('completions', { path: SHAPES, line: 22, symbol: 'square.', filter: 'sc' });
      assert.match(text, /^scale \(Method\)/m);
      assert.doesNotMatch(text, /^side /m);
    });

    it('reports a symbol that is not on the line, and a line past the end', async () => {
      assert.match(await live.client.fails('find_definition', { path: FILE, line: 10, symbol: 'nope' }), /"nope" is not on line 10/);
      assert.match(await live.client.fails('find_definition', { path: FILE, line: 99, symbol: 'x' }), /Line 99 is past the end/);
    });
  });
