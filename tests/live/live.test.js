'use strict';

/*
 * Live tests: start a real VS Code window with this extension loaded from source, on a copy of
 * fixture/, and call every MCP tool over HTTP. Run with `npm run test:live`; see README.md in this folder.
 */

const { before, after } = require('node:test');
const { LiveVsCode } = require('./harness/vscode');

const START_TIMEOUT_MS = 180000;
/** Run in this order, in one window. `settings` goes last: it changes the shared client's token and the settings files. */
const SUITES = [
  'workspace',
  'commands',
  'terminals',
  'tasks',
  'search',
  'language',
  'diagnostics',
  'editing',
  'debug',
  'output',
  'testing',
  'extensions',
  'settings',
];

const live = new LiveVsCode();

before(() => live.start(), { timeout: START_TIMEOUT_MS });
after(() => live.stop());

for (const suite of SUITES) {
  require(`./suites/${suite}`)(live);
}
