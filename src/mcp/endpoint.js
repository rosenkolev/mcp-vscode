'use strict';

const vscode = require('vscode');
const { closeServer, BIND_ADDRESS, ENDPOINT_PATH } = require('./server');

const SETTINGS_SECTION = 'mcpVscode';
const DEFAULT_PORT = 47391;
const LABEL = 'MCP VS Code';
const MAIN_PORT_RETRY_MS = 1000;

function endpointUrl(port) {
  return `http://${BIND_ADDRESS}:${port}${ENDPOINT_PATH}`;
}

/** A valid TCP port from the setting, else the default. */
function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}

function readSettings() {
  const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
  return { enabled: configuration.get('enabled', true), port: validPort(configuration.get('port', DEFAULT_PORT)) };
}

/** The bearer token clients must send, or '' when none is set. Only user settings count. */
function authToken() {
  const token = vscode.workspace.getConfiguration(SETTINGS_SECTION).inspect('authToken')?.globalValue;
  return typeof token === 'string' ? token.trim() : '';
}

/** The Authorization header for `token`, as an object to spread into headers; empty without a token. */
function bearerHeader(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Serves an McpHttpServer on a port of its own for this window, and on the configured main port when
 * free. Only one window can bind the main port; it runs each call in the caller's own window. The other
 * windows retry every second, so one takes over when that window closes. Shows the state in the status
 * bar and lists this window's own port for VS Code chat.
 */
class McpEndpoint {
  /**
   * @param {import('./server').McpHttpServer} server
   * @param {import('./windows').WindowRegistry} registry
   */
  constructor(server, registry, log) {
    this.server = server;
    this.registry = registry;
    this.log = log;
    /** @type {import('http').Server | undefined} */
    this.mainServer = undefined;
    /** @type {import('http').Server | undefined} */
    this.windowServer = undefined;
    this.windowPort = undefined;
    this.retryTimer = undefined;
    this.disposed = false;
    this.waitingForMainPort = false;
    /** Lifecycle steps run one after another, so two quick settings changes cannot race for the port. */
    this.queue = Promise.resolve();
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
    this.definitionsChanged = new vscode.EventEmitter();
  }

  get url() {
    return endpointUrl(readSettings().port);
  }

  /** Runs `step` after the queued steps; a failure is logged and never leaves the queue rejected. */
  enqueue(step) {
    this.queue = this.queue.then(() => (this.disposed ? undefined : step())).catch((error) => this.log.error(`MCP endpoint: ${error.message}`));
    return this.queue;
  }

  restart() {
    return this.enqueue(() => this.start());
  }

  /** Re-registers this window, e.g. after its folders or terminals change. */
  refreshRegistration() {
    return this.enqueue(() => this.windowPort !== undefined && this.register());
  }

  register() {
    return this.registry.register(readSettings().port, this.windowPort, Boolean(this.mainServer));
  }

  async stop() {
    clearTimeout(this.retryTimer);
    this.waitingForMainPort = false;
    await Promise.all([closeServer(this.mainServer), closeServer(this.windowServer)]);
    this.mainServer = undefined;
    this.windowServer = undefined;
    this.windowPort = undefined;
    this.registry.unregister();
    this.definitionsChanged.fire();
  }

  async start() {
    await this.stop();
    if (!readSettings().enabled) {
      this.statusItem.hide();
      return;
    }
    try {
      this.windowServer = await this.server.listen(0);
      this.windowPort = this.windowServer.address().port;
      this.definitionsChanged.fire();
      // Registered before the main port is bound, so the first routed call already finds this window.
      await this.register();
    } catch (error) {
      this.log.warn(`Not serving: ${error.message}`);
      this.showStatus('$(debug-disconnect)', `Not serving: ${error.message} Click to retry.`, 'mcpVscode.restartServer');
      return;
    }
    await this.claimMainPort();
  }

  /** Binds the main port, or shows that another window serves it and retries later. */
  async claimMainPort() {
    const { port } = readSettings();
    try {
      this.mainServer = await this.server.listen(port, { routing: true });
    } catch (error) {
      const reason = error.code === 'EADDRINUSE' ? `Port ${port} is served by another VS Code window, which passes this window's calls on.` : error.message;
      if (!this.waitingForMainPort) {
        this.log.info(`${reason} This window serves ${endpointUrl(this.windowPort)}.`);
        this.showStatus('$(plug)', `${reason} Agents started in this window work in this window.`, 'mcpVscode.showLog');
      }
      this.waitingForMainPort = true;
      this.retryTimer = setTimeout(() => this.enqueue(() => this.windowServer && !this.mainServer && this.claimMainPort()), MAIN_PORT_RETRY_MS);
      return;
    }
    this.waitingForMainPort = false;
    await this.register();
    this.log.info(`Serving MCP on ${endpointUrl(port)} for every window, and for this window on ${endpointUrl(this.windowPort)}`);
    this.showStatus('$(server-process)', `Serving ${endpointUrl(port)}; each agent works in its own window.`, 'mcpVscode.showLog');
  }

  showStatus(icon, tooltip, command) {
    Object.assign(this.statusItem, { text: `${icon} ${LABEL}`, tooltip, command });
    this.statusItem.show();
  }

  /**
   * Lists this window's own port under @mcp in the Extensions view and offers its tools to VS Code chat
   * agents, so chat in each window acts in that window.
   */
  registerDefinitionProvider(id) {
    return vscode.lm.registerMcpServerDefinitionProvider(id, {
      onDidChangeMcpServerDefinitions: this.definitionsChanged.event,
      provideMcpServerDefinitions: () =>
        this.windowPort === undefined
          ? []
          : [new vscode.McpHttpServerDefinition(LABEL, vscode.Uri.parse(endpointUrl(this.windowPort)), bearerHeader(authToken()))],
    });
  }

  /** True when a configuration change touches the settings that decide whether and where the endpoint serves. */
  static affects(event) {
    return ['enabled', 'port'].some((key) => event.affectsConfiguration(`${SETTINGS_SECTION}.${key}`));
  }

  /** True when the bearer token changed, which changes the chat definition. */
  static affectsToken(event) {
    return event.affectsConfiguration(`${SETTINGS_SECTION}.authToken`);
  }

  dispose() {
    const stopped = this.enqueue(() => this.stop());
    this.disposed = true;
    this.statusItem.dispose();
    this.definitionsChanged.dispose();
    return stopped;
  }
}

module.exports = { McpEndpoint, authToken, bearerHeader };
