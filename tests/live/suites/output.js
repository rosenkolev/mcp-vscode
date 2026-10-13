'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('output channels', () => {
    it('lists the channels, including this extension log', async () => {
      assert.match(await live.client.ok('list_output_channels'), /^MCP VS Code \([\w-]+\.mcp-vscode\)$/m);
    });

    it('reads and filters a channel', async () => {
      assert.match(await live.client.ok('read_output_channel', { name: 'MCP VS Code', filter: 'Serving MCP' }), /Serving MCP on/);
      assert.match(await live.client.fails('read_output_channel', { name: 'zzz' }), /No Output channel "zzz"/);
    });
  });
