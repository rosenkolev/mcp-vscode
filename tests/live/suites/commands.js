'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('commands', () => {
    it('lists contributed commands with their titles', async () => {
      const text = await live.client.ok('list_commands', { filter: 'mcpVscode' });
      assert.match(text, /mcpVscode\.restartServer - MCP VS Code: Restart Server/);
    });

    it('runs a command and returns its result as JSON', async () => {
      assert.match(await live.client.ok('run_command', { command: 'vscode.getEditorLayout' }), /Result:[\s\S]*"groups"/);
    });

    it('reports an unknown command', async () => {
      assert.match(await live.client.fails('run_command', { command: 'no.such.command' }), /not found/);
    });
  });
