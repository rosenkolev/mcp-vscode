'use strict';

const cp = require('child_process');
const fs = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { McpClient } = require('./client');

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..', '..');
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixture');
const WORKSPACE_FILE = 'test.code-workspace';
const START_TIMEOUT_MS = 120000;
const STOP_TIMEOUT_MS = 20000;
const POLL_MS = 500;

/** Settings of the isolated profile: this run's port, and nothing that asks the user anything. */
const BASE_USER_SETTINGS = {
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'git.enabled': false,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `check` returns a truthy value, polling until `timeoutMs` passes. */
async function eventually(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const IS_WINDOWS = process.platform === 'win32';

/**
 * Full path of the VS Code command line: $VSCODE_CLI, else `code` found on PATH. The full path matters on
 * Windows, where code.cmd finds VS Code relative to its own folder and fails when started by bare name.
 */
async function cliPath() {
  if (process.env.VSCODE_CLI) {
    return process.env.VSCODE_CLI;
  }
  const names = IS_WINDOWS ? ['code.cmd'] : ['code'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) {
        return candidate;
      }
    }
  }
  throw new Error('VS Code command line not found: put `code` on PATH or set VSCODE_CLI.');
}

/** Starts the VS Code command line detached. A Windows .cmd script needs a shell, so it gets one quoted command line. */
async function launch(args) {
  const cli = await cliPath();
  const child = IS_WINDOWS
    ? cp.spawn([cli, ...args].map((value) => `"${value}"`).join(' '), { shell: true, stdio: 'ignore', windowsHide: true })
    : cp.spawn(cli, args, { stdio: 'ignore', detached: true });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Cannot start VS Code (${cli}): ${error.message}`)));
    child.once('spawn', resolve);
  });
}

/**
 * A VS Code window on a copy of the fixture workspace, with this extension loaded from source and
 * everything else isolated in a temporary folder: user data, extensions and port.
 */
class LiveVsCode {
  async start() {
    // The long path: a Windows 8.3 short path (C:\Users\ABCDEF~1) keeps debugger breakpoints from binding.
    this.root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-vscode-live-')));
    this.workspaceDir = path.join(this.root, 'workspace');
    this.userDataDir = path.join(this.root, 'user-data');
    this.extensionsDir = path.join(this.root, 'extensions');
    await fs.cp(FIXTURE_DIR, this.workspaceDir, { recursive: true });
    await fs.mkdir(this.extensionsDir, { recursive: true });
    this.port = await freePort();
    await this.writeUserSettings({});
    this.client = new McpClient(this.port);

    await launch([
      '--new-window',
      '--user-data-dir',
      this.userDataDir,
      '--extensions-dir',
      this.extensionsDir,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      this.workspaceFile,
    ]);
    await eventually(() => this.client.ping(), START_TIMEOUT_MS, `the MCP endpoint on port ${this.port}`);
    return this.client;
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

  /** Replaces the `settings` block of the .code-workspace file. */
  async writeWorkspaceSettings(settings) {
    const workspace = JSON.parse(await fs.readFile(this.workspaceFile, 'utf8'));
    workspace.settings = settings;
    await fs.writeFile(this.workspaceFile, JSON.stringify(workspace, null, 2));
  }

  /** Closes the window, waits until the endpoint is gone, and deletes the temporary folder. */
  async stop() {
    if (this.client) {
      await this.client.call('run_command', { command: 'workbench.action.closeWindow' }).catch(() => undefined);
      await eventually(async () => !(await this.client.ping().catch(() => false)), STOP_TIMEOUT_MS, 'VS Code to close').catch(
        (error) => console.warn(`${error.message}; close the test window by hand.`),
      );
    }
    if (this.root) {
      // VS Code may hold files a moment after its window closes.
      await fs.rm(this.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((error) =>
        console.warn(`Could not delete ${this.root}: ${error.message}`),
      );
    }
  }
}

module.exports = { LiveVsCode, eventually, sleep };
