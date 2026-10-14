'use strict';

/** JSON-RPC 2.0 messages and the MCP tool-result shape, shared by the server and the call router. */

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

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/** A tools/call result: one text block, flagged as an error when the tool failed. */
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError } : {}) };
}

const isRequest = (message) => Boolean(message) && typeof message === 'object' && message.id !== undefined && typeof message.method === 'string';
const isToolCall = (message) => isRequest(message) && message.method === 'tools/call';
/** A client's reply to a request the server sent. */
const isResponse = (message) => Boolean(message) && typeof message === 'object' && message.id !== undefined && message.method === undefined;

module.exports = { RpcErrorCode, RpcError, rpcError, rpcResult, toolResult, isRequest, isToolCall, isResponse };
