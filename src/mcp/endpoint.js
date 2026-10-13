'use strict';

const vscode = require('vscode');

const SETTINGS_SECTION = 'mcpVscode';
const DEFAULT_PORT = 47391;
const LABEL = 'MCP VS Code';

function endpointUrl(port) {
  return ['http:', '', `127.0.0.1:${port}`, 'mcp'].join('/');
}

function readSettings() {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return { enabled: configuration.get('enabled', true), port: configuration.get('port', DEFAULT_PORT) };
}

/**
 * Serves an McpHttpServer on the configured port, shows its state in the status bar and lists it for VS Code
 * chat. Only one window can bind the port; the others show why they do not serve.
 */
class McpEndpoint {
  /** @param {import('./server').McpHttpServer} server */
  constructor(server, log) {
    this.server = server;
    this.log = log;
    /** Port this window serves; other windows list no server, since the port would reach this window. */
    this.servedPort = undefined;
    /** Restarts run one after another, so two quick settings changes cannot race for the port. */
    this.restarting = Promise.resolve();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.definitionsChanged = new vscode.EventEmitter();
  }

  get url() {
    return endpointUrl(readSettings().port);
  }

  restart() {
    // A failed start must not leave the chain rejected, or no later restart would run.
    this.restarting = this.restarting.catch(() => undefined).then(() => this.start());
    return this.restarting;
  }

  async start() {
    await this.server.close();
    this.setServedPort(undefined);
    const { enabled, port } = readSettings();
    if (!enabled) {
      this.statusItem.hide();
      return;
    }
    try {
      await this.server.listen(port);
      this.setServedPort(port);
      this.log.info(`Serving MCP on ${endpointUrl(port)}`);
      this.showStatus('$(server-process)', `Serving ${endpointUrl(port)}`, 'mcpVscode.showLog');
    } catch (error) {
      const reason = error.code === 'EADDRINUSE' ? `Port ${port} is in use, probably by another VS Code window.` : error.message;
      this.log.warn(`Not serving: ${reason}`);
      this.showStatus('$(debug-disconnect)', `${reason} Click to retry.`, 'mcpVscode.restartServer');
    }
  }

  setServedPort(port) {
    this.servedPort = port;
    this.definitionsChanged.fire();
  }

  showStatus(icon, tooltip, command) {
    Object.assign(this.statusItem, { text: `${icon} ${LABEL}`, tooltip, command });
    this.statusItem.show();
  }

  /** Lists the server under @mcp in the Extensions view and offers its tools to VS Code chat agents. */
  registerDefinitionProvider(id) {
    return vscode.lm.registerMcpServerDefinitionProvider(id, {
      onDidChangeMcpServerDefinitions: this.definitionsChanged.event,
      provideMcpServerDefinitions: () =>
        this.servedPort === undefined ? [] : [new vscode.McpHttpServerDefinition(LABEL, vscode.Uri.parse(endpointUrl(this.servedPort)))],
    });
  }

  /** True when a configuration change touches the settings that decide whether and where the endpoint serves. */
  static affects(event) {
    return ['enabled', 'port'].some((key) => event.affectsConfiguration(`${SETTINGS_SECTION}.${key}`));
  }

  dispose() {
    this.statusItem.dispose();
    this.definitionsChanged.dispose();
    return this.server.close();
  }
}

module.exports = { McpEndpoint };
