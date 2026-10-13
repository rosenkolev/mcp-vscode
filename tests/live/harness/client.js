'use strict';

const http = require('http');

/** Minimal MCP client for the extension's endpoint: plain JSON-RPC over HTTP POST. */
class McpClient {
  constructor(port) {
    this.port = port;
    this.nextId = 0;
  }

  /** Sends one JSON-RPC request and resolves with the parsed reply. */
  request(method, params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.nextId, method, params });
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: this.port, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(text));
            } catch (error) {
              reject(new Error(`Invalid reply to ${method}: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Resolves once the endpoint answers a ping. */
  async ping() {
    const reply = await this.request('ping', {});
    return reply.result !== undefined;
  }

  /** Names of the tools the endpoint lists. */
  async toolNames() {
    const reply = await this.request('tools/list', {});
    return reply.result.tools.map((tool) => tool.name);
  }

  /** Instructions sent on initialize. */
  async instructions() {
    const reply = await this.request('initialize', { protocolVersion: '2025-06-18' });
    return reply.result.instructions;
  }

  /**
   * Calls a tool and resolves with `{ ok, text }`; `ok` is false when the tool reported an error.
   * A JSON-RPC error rejects.
   */
  async call(name, args = {}) {
    const reply = await this.request('tools/call', { name, arguments: args });
    if (reply.error) {
      throw new Error(`${name}: ${reply.error.message}`);
    }
    return { ok: !reply.result.isError, text: reply.result.content?.[0]?.text ?? '' };
  }

  /** Calls a tool that must succeed and resolves with its text. */
  async ok(name, args) {
    const { ok, text } = await this.call(name, args);
    if (!ok) {
      throw new Error(`${name} failed: ${text}`);
    }
    return text;
  }

  /** Calls a tool that must fail and resolves with its error text. */
  async fails(name, args) {
    const { ok, text } = await this.call(name, args);
    if (ok) {
      throw new Error(`${name} was expected to fail but returned: ${text}`);
    }
    return text;
  }
}

module.exports = { McpClient };
