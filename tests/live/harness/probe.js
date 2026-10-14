'use strict';

/*
 * An MCP client as an agent in a VS Code terminal runs it: calls one tool on the main port and prints
 * the result as one JSON line tagged with a nonce, so a test can tell this call's result from any
 * earlier output in the same terminal. Usage: node probe.js <port> <tool> <nonce> [root]
 */
const { McpClient } = require('./client');

const TIMEOUT_MS = 30000;

const [port, tool, nonce, root] = process.argv.slice(2);
const client = new McpClient(Number(port), { roots: root ? [root] : [] });
const timer = setTimeout(() => {
  console.log(`PROBE ${nonce} ${JSON.stringify({ ok: false, text: `no reply within ${TIMEOUT_MS / 1000}s` })}`);
  process.exit(1);
}, TIMEOUT_MS);
client
  .call(tool)
  .then(({ ok, text }) => console.log(`PROBE ${nonce} ${JSON.stringify({ ok, text, rootsRequests: client.rootsRequests })}`))
  .catch((error) => {
    console.log(`PROBE ${nonce} ${JSON.stringify({ ok: false, text: error.message })}`);
    process.exitCode = 1;
  })
  .finally(() => clearTimeout(timer));
