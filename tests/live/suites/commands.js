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

    it('passes arbitrary JSON arguments to a command unchanged', async () => {
      const args = ['https://example.com', '', 0, 1.5, true, false, null, [1, 'nested'], { nested: { value: 1 } }];
      const text = await live.client.ok('run_command', { command: 'mcp-vscode-fixture.echo', args });
      const result = text.slice(text.indexOf('Result:\n') + 'Result:\n'.length);
      assert.deepEqual(JSON.parse(result), args);
    });

    it('reports an unknown command', async () => {
      assert.match(await live.client.fails('run_command', { command: 'no.such.command' }), /not found/);
    });
  });
