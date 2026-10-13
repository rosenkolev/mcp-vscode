'use strict';

const http = require('http');
const { parseArgs } = require('./args');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
const BIND_ADDRESS = '127.0.0.1';
const ENDPOINT_PATH = '/mcp';
const MAX_BODY_BYTES = 1024 * 1024;

const RpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
};

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

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
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Stateless MCP server over Streamable HTTP: every POST carries JSON-RPC and gets a plain JSON reply.
 * Tools are `{ name, description, inputSchema, handler(args) => Promise<string> }`; arguments reach
 * the handler validated against `inputSchema`, with its defaults applied. `disabledTools()` returns the
 * names to leave out of the tool list and refuse to run; it is read on every request, so a change
 * applies without a restart.
 */
class McpHttpServer {
  constructor({ name, version, instructions, tools, disabledTools = () => new Set(), log }) {
    this.serverInfo = { name, version };
    this.instructions = instructions;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
    this.disabledTools = disabledTools;
    this.log = log;
    /** @type {http.Server | undefined} */
    this.server = undefined;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) =>
        this.handle(req, res).catch((error) => {
          this.log.error(`Request failed: ${error.message}`);
          if (!res.headersSent) {
            sendJson(res, 500, rpcError(null, RpcErrorCode.internalError, error.message));
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
        this.server = server;
        resolve();
      });
    });
  }

  close() {
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  async handle(req, res) {
    // DNS-rebinding guard: only local Host headers, and no browser-originated requests.
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!LOCAL_HOSTNAMES.includes(hostname) || req.headers.origin) {
      sendJson(res, 403, rpcError(null, RpcErrorCode.invalidRequest, 'Forbidden'));
      return;
    }
    if ((req.url ?? '').split('?')[0] !== ENDPOINT_PATH) {
      sendJson(res, 404, rpcError(null, RpcErrorCode.invalidRequest, 'Not found'));
      return;
    }
    if (req.method !== 'POST') {
      // No server-initiated stream: this server never sends notifications.
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }

    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch (error) {
      sendJson(res, 400, rpcError(null, RpcErrorCode.parseError, error.message));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const responses = (await Promise.all(messages.map((entry) => this.dispatch(entry)))).filter(Boolean);
    if (!responses.length) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, 200, Array.isArray(message) ? responses : responses[0]);
  }

  /** Answers a request; notifications and client responses carry no id and get no reply. */
  async dispatch(message) {
    if (!message || typeof message !== 'object') {
      return rpcError(null, RpcErrorCode.invalidRequest, 'Invalid request');
    }
    if (message.id === undefined || typeof message.method !== 'string') {
      return undefined;
    }
    try {
      return { jsonrpc: '2.0', id: message.id, result: await this.call(message.method, message.params ?? {}) };
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
      return {
        content: [{ type: 'text', text: `${name} is disabled by the user in the VS Code setting "mcpVscode.disabledTools".` }],
        isError: true,
      };
    }
    try {
      const text = await tool.handler(parseArgs(tool.inputSchema, args ?? {}));
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      this.log.warn(`${name} failed: ${error.message}`);
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
  }
}

module.exports = { McpHttpServer };
