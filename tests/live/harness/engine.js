'use strict';

const path = require('path');
const { McpClient } = require('./client');
const { TestFixture } = require('./fixture');
const { eventually } = require('./poll');
const { cliPath, launch, onPath, runToEnd } = require('./processes');
const { EXTENSION_ROOT, STOP_TIMEOUT_MS } = require('./vscode');

const ENGINES_DIR = path.resolve(__dirname, '..', 'engines');
const START_TIMEOUT_MS = 120000;
const IS_WINDOWS = process.platform === 'win32';

/** Prepares an engine project in `dir`: installs what its tests need, returns settings it requires. */
const SETUPS = {
  async npm(dir) {
    await runToEnd(await onPath('npm'), ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir });
    return {};
  },
  async venv(dir) {
    const launcher = IS_WINDOWS ? 'py' : 'python3';
    await runToEnd(launcher, ['-m', 'venv', '.venv'], { cwd: dir });
    const python = path.join(dir, '.venv', IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'python.exe' : 'python');
    await runToEnd(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', 'requirements.txt'], { cwd: dir });
    return { 'python.defaultInterpreterPath': python };
  },
  none: async () => ({}),
};

/**
 * One VS Code window on a copy of an engine project (tests/live/engines/<name>), in a temporary profile
 * with only that engine's test extension installed from the Marketplace, and this extension from source.
 */
class LiveEngine {
  /** @param {{ name: string, extension: string, setup: keyof SETUPS, settings?: object }} engine */
  constructor(engine) {
    this.engine = engine;
    this.fixture = new TestFixture();
  }

  async start() {
    const { name, extension, setup, settings = {} } = this.engine;
    await this.fixture.create(`mcp-vscode-engine-${name}-`, path.join(ENGINES_DIR, name));
    const { userDataDir, extensionsDir, workspaceDir, port } = this.fixture;
    const setupSettings = await SETUPS[setup](workspaceDir);
    await this.fixture.writeUserSettings({ ...settings, ...setupSettings });
    await runToEnd(await cliPath(), ['--user-data-dir', userDataDir, '--extensions-dir', extensionsDir, '--install-extension', extension]);
    // The tests run outside VS Code, so the endpoint places their calls by this MCP root.
    this.client = new McpClient(port, { roots: [workspaceDir] });
    await launch(await cliPath(), [
      '--new-window',
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      `--extensionDevelopmentPath=${EXTENSION_ROOT}`,
      workspaceDir,
    ]);
    await eventually(() => this.client.ping(), START_TIMEOUT_MS, `the MCP endpoint of the ${name} window`);
  }

  async stop() {
    if (this.client) {
      await this.client.call('run_command', { command: 'workbench.action.closeWindow' }).catch(() => undefined);
      await eventually(async () => !(await this.client.ping().catch(() => false)), STOP_TIMEOUT_MS, 'VS Code to close').catch(() => undefined);
    }
    await this.fixture.remove();
  }
}

module.exports = { LiveEngine };
