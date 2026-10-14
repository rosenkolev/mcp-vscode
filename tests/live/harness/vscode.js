'use strict';

const path = require('path');
const { McpClient } = require('./client');
const { TestFixture } = require('./fixture');
const { eventually } = require('./poll');
const { cliPath, launch } = require('./processes');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const START_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 20000;

/**
 * A VS Code window on a copy of the fixture workspace, with this extension loaded from source and
 * everything else isolated in a temporary folder: user data, extensions and port.
 */
class LiveVsCode {
  constructor() {
    this.fixture = new TestFixture();
  }

  async start() {
    await this.fixture.create('mcp-vscode-live-');
    const { userDataDir, extensionsDir, workspaceFile, port } = this.fixture;
    this.port = port;
    // The tests run outside VS Code, so the endpoint places their calls by this MCP root.
    this.client = new McpClient(port, { roots: [this.file('a')] });
    await launch(await cliPath(), [
      '--new-window',
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      workspaceFile,
    ]);
    try {
      await eventually(() => this.client.ping(), START_TIMEOUT_MS, `the MCP endpoint on port ${port}`);
    } catch (error) {
      await this.fixture.remove();
      throw error;
    }
    return this.client;
  }

  get root() {
    return this.fixture.root;
  }

  /** Path of a fixture file in this run's copy of the workspace. */
  file(...segments) {
    return this.fixture.file(...segments);
  }

  writeUserSettings(settings) {
    return this.fixture.writeUserSettings(settings);
  }

  writeWorkspaceSettings(settings) {
    return this.fixture.writeWorkspaceSettings(settings);
  }

  /** Closes the window, waits until the endpoint is gone, and deletes the temporary folder. */
  async stop() {
    if (this.client) {
      await this.client.call('run_command', { command: 'workbench.action.closeWindow' }).catch(() => undefined);
      await eventually(async () => !(await this.client.ping().catch(() => false)), STOP_TIMEOUT_MS, 'VS Code to close').catch(
        (error) => console.warn(`${error.message}; it is killed instead.`),
      );
    }
    await this.fixture.remove();
  }
}

module.exports = { LiveVsCode, EXTENSION_ROOT, STOP_TIMEOUT_MS };
