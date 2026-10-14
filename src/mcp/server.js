'use strict';

const http = require('http');
const crypto = require('crypto');
const { parseArgs } = require('./args');
const { RpcErrorCode, RpcError, rpcError, rpcResult, toolResult, isRequest, isToolCall, isResponse } = require('./rpc');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const BIND_ADDRESS = '127.0.0.1';
const ENDPOINT_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // The rest is drained, not read, so the client still receives the 413 reply.
        req.removeAllListeners('data');
        req.resume();
        reject(new BodyTooLargeError(`Request body over ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Closes an http.Server returned by `McpHttpServer.listen`, dropping its open connections. */
function closeServer(server) {
  if (!server) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** True when `header` is "Bearer <token>"; compared in constant time. */
function hasToken(header, token) {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? '');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * Stateless MCP server over Streamable HTTP: every POST carries JSON-RPC and gets a JSON reply.
 * Tools are `{ name, description, inputSchema, handler(args) => Promise<string> }`; arguments reach
 * the handler validated against `inputSchema`, with its defaults applied. `disabledTools()` returns the
 * names to leave out of the tool list and refuse to run; it is read on every request, so a change
 * applies without a restart. `authToken()`, when it returns a token, is required as a bearer token.
 * A listener started with `routing` hands tool calls to the `router`, which runs each in the client's
 * own VS Code window.
 */
class McpHttpServer {
  constructor({ name, version, instructions, tools, disabledTools = () => new Set(), authToken = () => '', log }) {
    this.serverInfo = { name, version };
    this.instructions = instructions;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.disabledTools = disabledTools;
    this.authToken = authToken;
    this.log = log;
    /** @type {import('./router').CallRouter | undefined} */
    this.router = undefined;
  }

  /**
   * Serves on `port` (0 picks a free one) and resolves with the http.Server; close it with `closeServer`.
   * With `routing`, tool calls run in the client's own window through the router.
   */
  listen(port, { routing = false } = {}) {
    if (routing && !this.router) {
      throw new Error('A routing listener needs a router.');
    }
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) =>
        this.handle(req, res, routing).catch((error) => {
          this.log.error(`Request failed: ${error.message}`);
          if (!res.headersSent) {
            sendJson(res, 500, rpcError(null, RpcErrorCode.internalError, error.message));
          } else {
            res.end();
          }
        }),
      );
      // Tool calls may wait minutes for a task to finish.
      server.requestTimeout = 0;
      server.timeout = 0;
      server.once('error', reject);
      server.listen(port, BIND_ADDRESS, () => {
        server.off('error', reject);
        server.on('error', (error) => this.log.error(`Server error: ${error.message}`));
        resolve(server);
      });
    });
  }

  /** Refuses requests that are not local, not authorized, or not for the endpoint; true when refused. */
  refuse(req, res) {
    // DNS-rebinding guard: only local Host headers, and no browser-originated requests.
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTNAMES.includes(hostname) || req.headers.origin) {
      sendJson(res, 403, rpcError(null, RpcErrorCode.invalidRequest, 'Forbidden'));
      return true;
    }
    const token = this.authToken();
    if (token && !hasToken(req.headers.authorization, token)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      sendJson(res, 401, rpcError(null, RpcErrorCode.invalidRequest, 'Unauthorized: set the header "Authorization: Bearer <mcpVscode.authToken>".'));
      return true;
    }
    if ((req.url ?? '').split('?')[0] !== ENDPOINT_PATH) {
      sendJson(res, 404, rpcError(null, RpcErrorCode.invalidRequest, 'Not found'));
      return true;
    }
    if (req.method !== 'POST') {
      // No server-initiated stream: this server never sends notifications.
      res.writeHead(405, { Allow: 'POST' }).end();
      return true;
    }
    return false;
  }

  async handle(req, res, routing) {
    if (this.refuse(req, res)) {
      return;
    }
    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      sendJson(res, tooLarge ? 413 : 400, rpcError(null, tooLarge ? RpcErrorCode.invalidRequest : RpcErrorCode.parseError, error.message));
      return;
    }
    const batch = Array.isArray(message);
    if (batch && !message.length) {
      sendJson(res, 400, rpcError(null, RpcErrorCode.invalidRequest, 'Empty batch'));
      return;
    }
    const messages = batch ? message : [message];
    const answered = new Set();
    for (const entry of messages) {
      if (isResponse(entry) && this.router?.receiveAnswer(entry)) {
        answered.add(entry);
      }
    }
    // Every window has the same tools, so an unknown one is refused here without finding a window.
    if (routing && !batch && isToolCall(message) && this.tools.has(message.params?.name)) {
      await this.router.route(req, res, message, sendJson);
      return;
    }
    const dispatch = (entry) => {
      if (answered.has(entry)) {
        return undefined;
      }
      return routing && isToolCall(entry) && this.tools.has(entry.params?.name) ? this.router.routeInBatch(req.socket, entry) : this.dispatch(entry);
    };
    const responses = (await Promise.all(messages.map(dispatch))).filter(Boolean);
    if (!responses.length) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, batch ? responses : responses[0]);
  }

  /** Answers a request; notifications and client responses carry no id or method and get no reply. */
  async dispatch(message) {
    if (!message || typeof message !== 'object') {
      return rpcError(null, RpcErrorCode.invalidRequest, 'Invalid request');
    }
    if (!isRequest(message)) {
      return undefined;
    }
    try {
      return rpcResult(message.id, await this.call(message.method, message.params ?? {}));
    } catch (error) {
      const code = error instanceof RpcError ? error.code : RpcErrorCode.internalError;
      return rpcError(message.id, code, error.message);
    }
  }

  /** The instructions, plus which tools the user disabled, so a client does not plan with them. */
  currentInstructions() {
    const disabled = [...this.disabledTools()].filter((name) => this.tools.has(name));
    return disabled.length ? `${this.instructions} The user disabled these tools: ${disabled.join(', ')}.` : this.instructions;
  }

  async call(method, params) {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion
            : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.serverInfo,
          instructions: this.currentInstructions(),
        };
      case 'ping':
        return {};
      case 'tools/list': {
        const disabled = this.disabledTools();
        return {
          tools: [...this.tools.values()]
            .filter(({ name }) => !disabled.has(name))
            .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        };
      }
      case 'tools/call':
        return this.callTool(params);
      default:
        throw new RpcError(RpcErrorCode.methodNotFound, `Method not found: ${method}`);
    }
  }

  async callTool({ name, arguments: args }) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new RpcError(RpcErrorCode.invalidParams, `Unknown tool: ${name}`);
    }
    if (this.disabledTools().has(name)) {
      this.log.info(`Refused ${name}: disabled in settings`);
      return toolResult(`${name} is disabled by the user in the VS Code setting "mcpVscode.disabledTools".`, true);
    }
    try {
      return toolResult(await tool.handler(parseArgs(tool.inputSchema, args ?? {})));
    } catch (error) {
      this.log.warn(`${name} failed: ${error.message}`);
      return toolResult(error.message, true);
    }
  }
}

module.exports = { McpHttpServer, closeServer, BIND_ADDRESS, ENDPOINT_PATH };
