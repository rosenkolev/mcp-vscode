'use strict';

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { freePort, killProcessesMentioning } = require('./processes');

const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixture');
const WORKSPACE_FILE = 'test.code-workspace';

/** Settings of an isolated profile: nothing that asks the user anything or reaches the network. */
const BASE_USER_SETTINGS = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'git.enabled': false,
};

/**
 * A temporary folder holding a copy of the fixture workspace, a VS Code user-data folder with this run's
 * settings, an empty extensions folder, and a free port for the MCP endpoint.
 */
class TestFixture {
  async create(prefix) {
    // The long path: a Windows 8.3 short path (C:\Users\ABCDEF~1) differs from the paths VS Code reports
    // and keeps debugger breakpoints from binding.
    this.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    this.workspaceDir = path.join(this.root, 'workspace');
    this.userDataDir = path.join(this.root, 'user-data');
    this.extensionsDir = path.join(this.root, 'extensions');
    await fs.cp(FIXTURE_DIR, this.workspaceDir, { recursive: true });
    await fs.mkdir(this.extensionsDir, { recursive: true });
    this.port = await freePort();
    this.originalWorkspaceSettings = JSON.parse(await fs.readFile(this.workspaceFile, 'utf8')).settings ?? {};
    await this.writeUserSettings({});
  }

  get workspaceFile() {
    return path.join(this.workspaceDir, WORKSPACE_FILE);
  }

  /** Path of a fixture file in this run's copy of the workspace. */
  file(...segments) {
    return path.join(this.workspaceDir, ...segments);
  }

  /** Replaces the user settings, on top of the base settings and this run's port. */
  async writeUserSettings(settings) {
    const file = path.join(this.userDataDir, 'User', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ...BASE_USER_SETTINGS, 'mcpVscode.port': this.port, ...settings }, null, 2));
  }

  /** Replaces the `settings` block of the .code-workspace file, on top of the fixture's own settings. */
  async writeWorkspaceSettings(settings) {
    const workspace = JSON.parse(await fs.readFile(this.workspaceFile, 'utf8'));
    workspace.settings = { ...this.originalWorkspaceSettings, ...settings };
    await fs.writeFile(this.workspaceFile, JSON.stringify(workspace, null, 2));
  }

  /** Kills any VS Code process still using this fixture and deletes the temporary folder. */
  async remove() {
    if (!this.root) {
      return;
    }
    await killProcessesMentioning(this.userDataDir);
    // VS Code may hold files a moment after its window closes.
    await fs.rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error) =>
      console.warn(`Could not delete ${this.root}: ${error.message}`),
    );
  }
}

module.exports = { TestFixture, BASE_USER_SETTINGS, FIXTURE_DIR, WORKSPACE_FILE };
