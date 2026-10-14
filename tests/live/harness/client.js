'use strict';

const http = require('http');
const { pathToFileURL } = require('url');

/**
 * Minimal MCP client for the extension's endpoint: JSON-RPC over HTTP POST. A reply may come as an event
 * stream that first asks for the client's roots; the client answers with `roots` by POSTing back, as
 * MCP clients such as Claude Code do.
 */
class McpClient {
  /**
   * @param {number} port
   * @param {{ roots?: string[] }} [options] folders to report as MCP roots; none makes the client answer
   *   roots/list with an empty list.
   */
  constructor(port, { roots = [] } = {}) {
    this.port = port;
    this.nextId = 0;
    /** Bearer token to send, for an endpoint with mcpVscode.authToken set. */
    this.token = '';
    this.roots = roots;
    /** How many roots/list requests the server sent, so tests can tell how a call was placed. */
    this.rootsRequests = 0;
  }

  headers() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  /** POSTs one message and resolves with `{ status, type, body }` once the reply ends. */
  post(message, onEvent) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, path: '/mcp', method: 'POST', headers: this.headers() }, (res) => {
        const type = res.headers['content-type'] ?? '';
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
          if (type.startsWith('text/event-stream')) {
            // Events end with a blank line; each carries one JSON-RPC message in its data lines.
            let end;
            while ((end = text.indexOf('\n\n')) >= 0) {
              const data = text
                .slice(0, end)
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');
              text = text.slice(end + 2);
              if (data) {
                onEvent(JSON.parse(data));
              }
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, type, body: text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(message));
    });
  }

  /** Sends one JSON-RPC request and resolves with its reply, answering roots/list requests on the way. */
  async request(method, params) {
    const id = ++this.nextId;
    let reply;
    const answers = [];
    const { status, type, body } = await this.post({ jsonrpc: '2.0', id, method, params }, (event) => {
      if (event.method === 'roots/list') {
        this.rootsRequests += 1;
        const roots = this.roots.map((folder) => ({ uri: pathToFileURL(folder).href, name: folder }));
        answers.push(this.post({ jsonrpc: '2.0', id: event.id, result: { roots } }));
      } else if (event.id === id) {
        reply = event;
      }
    });
    await Promise.all(answers);
    if (type.startsWith('text/event-stream')) {
      if (!reply) {
        throw new Error(`The event stream of ${method} ended without a reply.`);
      }
      return reply;
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Invalid reply to ${method} (HTTP ${status}): ${body.slice(0, 200)}`);
    }
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
    const reply = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: { roots: {} } });
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
