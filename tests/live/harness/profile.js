'use strict';

const fs = require('fs/promises');
const path = require('path');
const { McpClient } = require('./client');
const { TestFixture } = require('./fixture');
const { eventually } = require('./poll');
const { cliPath, isAlive, launch, onPath, runToEnd, killProcessesMentioning } = require('./processes');
const { EXTENSION_ROOT, STOP_TIMEOUT_MS } = require('./vscode');
// The extension's own rule for where windows register, so the harness and the extension cannot drift apart.
const { registryDirectory } = require('../../../src/mcp/folders');

const WINDOW_START_TIMEOUT_MS = 120000;

/**
 * One isolated VS Code profile (user data and extensions folder) with this extension installed from a
 * packaged .vsix, as a user has it, and several windows of that profile open in one VS Code instance.
 */
class LiveProfile {
  constructor() {
    this.fixture = new TestFixture();
    /** Windows opened by the tests. @type {{ target: string, pid: number, port: number, name: string, folders: string[], client: McpClient }[]} */
    this.windows = [];
  }

  async start() {
    await this.fixture.create('mcp-vscode-windows-');
    this.port = this.fixture.port;
    this.registryDir = registryDirectory(this.port);
    await this.install();
  }

  /** Packages the extension and installs the .vsix into this profile. */
  async install() {
    const vsix = path.join(this.fixture.root, 'mcp-vscode.vsix');
    await runToEnd(await onPath('npx'), ['--yes', '@vscode/vsce@3', 'package', '--out', vsix], { cwd: EXTENSION_ROOT });
    await runToEnd(await cliPath(), ['--user-data-dir', this.fixture.userDataDir, '--extensions-dir', this.fixture.extensionsDir, '--install-extension', vsix]);
  }

  file(...segments) {
    return this.fixture.file(...segments);
  }

  writeUserSettings(settings) {
    return this.fixture.writeUserSettings(settings);
  }

  /** Registered windows of this run's main port, read from the extension's registry files. */
  async registry() {
    const names = await fs.readdir(this.registryDir).catch(() => []);
    const entries = await Promise.all(
      names.filter((name) => name.endsWith('.json')).map((name) => fs.readFile(path.join(this.registryDir, name), 'utf8').then(JSON.parse, () => undefined)),
    );
    return entries.filter((entry) => entry && isAlive(entry.pid));
  }

  /**
   * Opens a folder, .code-workspace file or single file in a new window of this profile and resolves once
   * that window has registered, with a client of the window's own port.
   */
  async open(target) {
    const known = new Set((await this.registry()).map((entry) => entry.pid));
    await launch(await cliPath(), ['--new-window', '--user-data-dir', this.fixture.userDataDir, '--extensions-dir', this.fixture.extensionsDir, target]);
    const entry = await eventually(
      async () => (await this.registry()).find((candidate) => !known.has(candidate.pid)),
      WINDOW_START_TIMEOUT_MS,
      `a window on ${target} to register`,
    );
    const window = { target, ...entry, client: new McpClient(entry.port) };
    this.windows.push(window);
    return window;
  }

  /** A client of the main port, reporting `roots` as its MCP roots. */
  mainClient(roots = []) {
    return new McpClient(this.port, { roots });
  }

  /** The window serving the main port. */
  async main() {
    return (await this.registry()).find((entry) => entry.main);
  }

  /** Closes a window and waits until its extension host is gone. */
  async close(window) {
    await window.client.call('run_command', { command: 'workbench.action.closeWindow' }).catch(() => undefined);
    await eventually(async () => !isAlive(window.pid), STOP_TIMEOUT_MS, `window ${window.name} to close`);
    this.windows = this.windows.filter((candidate) => candidate !== window);
  }

  /** Closes the windows, kills what is left of this profile's VS Code, and deletes the temporary folder. */
  async stop() {
    for (const window of [...this.windows]) {
      await this.close(window).catch((error) => console.warn(`${error.message}; it is killed instead.`));
    }
    await killProcessesMentioning(this.fixture.userDataDir);
    await fs.rm(this.registryDir, { recursive: true, force: true }).catch(() => undefined);
    await this.fixture.remove();
  }
}

module.exports = { LiveProfile };
