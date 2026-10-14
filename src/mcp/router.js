'use strict';

const http = require('http');
const crypto = require('crypto');
const { rpcResult, toolResult } = require('./rpc');

const ROOTS_TIMEOUT_MS = 5000;
const KEEPALIVE_MS = 15000;
/** Longer than the longest wait a tool accepts (timeout_seconds at most 600). */
const FORWARD_TIMEOUT_MS = 660000;
const MAX_FORWARD_REPLY_BYTES = 16 * 1024 * 1024;

const OUTSIDE_HINT = 'Start the agent from a terminal of the VS Code window it should work in.';

/** A JSON-RPC reply carrying a failed tool result. */
const failure = (id, text) => rpcResult(id, toolResult(text, true));

function sseEvent(message) {
  return `event: message\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * Runs each tools/call in the VS Code window its client belongs to. A client inside a window is placed
 * by its process ancestry. Any other client is answered as an event stream that first asks for the
 * client's MCP roots, so no session state is needed; the folder of the first root picks the window.
 * Calls for another window go to that window's own port; calls for this window run `dispatch` here.
 */
class CallRouter {
  /**
   * @param {object} options
   * @param {import('./windows').WindowRegistry} options.windows
   * @param {(message: object) => Promise<object>} options.dispatch runs a JSON-RPC request in this window
   * @param {(name: string) => boolean} options.isDisabled whether this window's settings disable a tool
   * @param {() => string} options.authToken
   * @param {string} options.bindAddress
   * @param {string} options.endpointPath
   */
  constructor({ windows, dispatch, isDisabled, authToken, bindAddress, endpointPath, log }) {
    this.windows = windows;
    this.dispatch = dispatch;
    this.isDisabled = isDisabled;
    this.authToken = authToken;
    this.bindAddress = bindAddress;
    this.endpointPath = endpointPath;
    this.log = log;
    /** Receivers of the client's answers to roots/list requests, by request id. @type {Map<string, (message: object) => void>} */
    this.pendingRoots = new Map();
  }

  /** Hands a client's answer to a pending roots/list request to its waiter; true when it was one. */
  receiveAnswer(message) {
    const receive = this.pendingRoots.get(String(message.id));
    if (!receive) {
      return false;
    }
    receive(message);
    return true;
  }

  /** The window whose process tree holds the client, or undefined; a failed lookup counts as unknown. */
  async windowOfClient(socket) {
    try {
      return await this.windows.windowOfConnection(socket);
    } catch (error) {
      this.log.warn(`Could not find the process of a client: ${error.message}`);
      return undefined;
    }
  }

  /** Answers one tools/call request, writing the reply to `res`. */
  async route(req, res, message, sendJson) {
    const window = await this.windowOfClient(req.socket);
    if (window) {
      sendJson(res, 200, await this.runIn(window, message));
      return;
    }
    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      const text = `This MCP client runs outside VS Code and cannot receive the roots/list request that finds its window. ${OUTSIDE_HINT}`;
      sendJson(res, 200, failure(message.id, text));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    // Comment lines keep idle proxies and clients from closing a stream that waits for a long call.
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), KEEPALIVE_MS);
    res.on('close', () => clearInterval(keepalive));
    let reply;
    try {
      const roots = await this.askRoots(res);
      reply = await this.runIn(await this.windows.windowOfRoots(roots), message);
    } catch (error) {
      reply = failure(message.id, error.message);
    }
    clearInterval(keepalive);
    res.end(sseEvent(reply));
  }

  /** Places a tools/call of a batch, which cannot carry the roots exchange, by process ancestry alone. */
  async routeInBatch(socket, message) {
    const window = await this.windowOfClient(socket);
    if (window) {
      return this.runIn(window, message);
    }
    const text = `This MCP client runs outside VS Code, so its window can only be found when it sends tool calls one per request. ${OUTSIDE_HINT}`;
    return failure(message.id, text);
  }

  /** Sends roots/list on the event stream and resolves with the roots the client POSTs back. */
  askRoots(res) {
    const id = `roots-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRoots.delete(id);
        reject(new Error(`This MCP client runs outside VS Code and did not answer the roots/list request that finds its window. ${OUTSIDE_HINT}`));
      }, ROOTS_TIMEOUT_MS);
      this.pendingRoots.set(id, (answer) => {
        clearTimeout(timer);
        this.pendingRoots.delete(id);
        if (answer.error || !Array.isArray(answer.result?.roots)) {
          reject(new Error(`The MCP client refused to list its roots: ${answer.error?.message ?? 'no roots'}.`));
        } else {
          resolve(answer.result.roots);
        }
      });
      res.write(sseEvent({ jsonrpc: '2.0', id, method: 'roots/list' }));
    });
  }

  /** Runs a JSON-RPC tool call here, or in another window through that window's own port. */
  async runIn(window, message) {
    if (window.pid === this.windows.pid) {
      return this.dispatch(message);
    }
    const name = message.params?.name;
    // This window's settings apply too, so a workspace lockdown holds for calls routed through it.
    if (this.isDisabled(name)) {
      return failure(message.id, `${name} is disabled by the user in the VS Code setting "mcpVscode.disabledTools".`);
    }
    try {
      return await this.forward(window.port, message);
    } catch (error) {
      return failure(message.id, `VS Code window "${window.name}" did not answer: ${error.message}`);
    }
  }

  /** Sends a JSON-RPC tool call to the window serving `port` and resolves with its reply to that call. */
  forward(port, message) {
    const body = JSON.stringify(message);
    const token = this.authToken();
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: this.bindAddress, port, path: this.endpointPath, method: 'POST', headers, timeout: FORWARD_TIMEOUT_MS },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_FORWARD_REPLY_BYTES) {
              req.destroy(new Error('reply too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}`));
              return;
            }
            let reply;
            try {
              reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (error) {
              reject(new Error(`unreadable reply (${error.message})`));
              return;
            }
            if (reply?.id !== message.id) {
              reject(new Error(`reply to another request (${JSON.stringify(reply?.error ?? reply?.id)})`));
              return;
            }
            resolve(reply);
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`no reply within ${FORWARD_TIMEOUT_MS / 1000}s`)));
      req.on('error', reject);
      req.end(body);
    });
  }
}

module.exports = { CallRouter };
