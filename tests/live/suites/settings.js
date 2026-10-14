'use strict';

const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');
const { eventually } = require('../harness/poll');

const SETTINGS_TIMEOUT_MS = 15000;
const REFUSED = /disabled by the user in the VS Code setting "mcpVscode\.disabledTools"/;

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('mcpVscode.disabledTools', { timeout: 90000 }, () => {
    /** Waits until VS Code has read the settings files, which `check` tells from the tool list. */
    const listed = (check) =>
      eventually(async () => check(await live.client.toolNames()), SETTINGS_TIMEOUT_MS, 'the settings change to apply');

    after(async () => {
      live.client.token = '';
      await live.writeUserSettings({});
      await live.writeWorkspaceSettings({});
    });

    it('hides and refuses a tool disabled in user settings, without a restart', async () => {
      await live.writeUserSettings({ 'mcpVscode.disabledTools': ['run_command'] });
      await listed((names) => !names.includes('run_command'));
      assert.match(await live.client.fails('run_command', { command: 'vscode.getEditorLayout' }), REFUSED);
      assert.match(await live.client.instructions(), /The user disabled these tools: run_command\./);
      assert.match(await live.client.ok('get_workspace'), /multi-root workspace/);
    });

    it('lets workspace settings add tools but not re-enable user-disabled ones', async () => {
      await live.writeWorkspaceSettings({ 'mcpVscode.disabledTools': ['search_in_files'] });
      await listed((names) => !names.includes('search_in_files'));
      assert.match(await live.client.fails('search_in_files', { query: 'needle' }), REFUSED);
      assert.match(await live.client.fails('run_command', { command: 'vscode.getEditorLayout' }), REFUSED);
    });

    it('warns about an unknown tool name', async () => {
      await live.writeUserSettings({ 'mcpVscode.disabledTools': ['bogus_tool'] });
      await listed((names) => names.includes('run_command'));
      const log = await live.client.ok('read_output_channel', { name: 'MCP VS Code', filter: 'unknown tools' });
      assert.match(log, /names unknown tools, which stay unaffected: bogus_tool/);
    });

    it('re-enables the tools once the settings are cleared', async () => {
      await live.writeUserSettings({});
      await live.writeWorkspaceSettings({});
      await listed((names) => names.includes('search_in_files') && names.includes('run_command'));
      assert.match(await live.client.ok('run_command', { command: 'vscode.getEditorLayout' }), /Result/);
    });

    it('requires the bearer token of user settings, and ignores one in workspace settings', async () => {
      const refused = async () => /Unauthorized/.test((await live.client.request('ping', {})).error?.message ?? '');
      await live.writeWorkspaceSettings({ 'mcpVscode.authToken': 'workspace-token' });
      await live.writeUserSettings({ 'mcpVscode.authToken': 'secret' });
      await eventually(refused, SETTINGS_TIMEOUT_MS, 'the token to apply');
      live.client.token = 'workspace-token';
      assert.ok(await refused(), 'the workspace token is refused');
      live.client.token = 'secret';
      assert.match(await live.client.ok('get_workspace'), /multi-root workspace/);
      await live.writeUserSettings({});
      live.client.token = '';
      await eventually(async () => !(await refused()), SETTINGS_TIMEOUT_MS, 'the token to be cleared');
    });
  });
