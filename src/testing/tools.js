'use strict';

const vscode = require('vscode');
const { withTimeout } = require('../shared/async');
const { NO_ARGS, pathProperty, timeoutProperty } = require('../shared/schema');
const { existingUri, relativePath } = require('../workspace/paths');
const { provide } = require('../shared/providers');

/** Built-in Test Explorer commands per run_tests scope; each resolves when its run ends. */
const RUN_COMMANDS = {
  all: 'testing.runAll',
  failed: 'testing.reRunFailTests',
  last: 'testing.reRunLastRun',
  current_file: 'testing.runCurrentFile',
};
const RESULTS_HINT =
  'Results are only visible in the Test Explorer; run the test command with run_in_terminal for readable output.';

const execute = (command, ...args) => vscode.commands.executeCommand(command, ...args);
const controllersWithTests = () => execute('vscode.testing.getControllersWithTests');

/** Handler that runs a command and replies with a fixed text. */
const runThenReply = (command, reply) => async () => {
  await execute(command);
  return reply;
};

/** `describe('name') callback`, as the TypeScript outline names a test callback; group 1 is the test name. */
const TEST_SYMBOL_PATTERN = /^(?:describe|suite|context|it|test)(?:\.\w+)*\((['"`])(.*)\1\) callback$/;

/**
 * "name (line N)" of each describe/it/test block in the language server's outline, nested as in the file.
 * Test controllers expose only internal ids through the API, so the outline supplies readable names.
 */
function testOutline(symbols, depth = 0) {
  return [...symbols]
    .sort((a, b) => a.range.start.line - b.range.start.line)
    .flatMap((symbol) => {
      const name = TEST_SYMBOL_PATTERN.exec(symbol.name)?.[2];
      const children = testOutline(symbol.children ?? [], name ? depth + 1 : depth);
      return name ? [`${'  '.repeat(depth + 1)}${name} (line ${symbol.range.start.line + 1})`, ...children] : children;
    });
}

/**
 * The tests of a file that the Test Explorer knows, named from the outline. The item count is left out:
 * some controllers (Vitest) discover a file's tests only once it is open in an editor.
 */
async function describeTestsInFile(input) {
  const uri = await existingUri(input);
  const [ids, symbols] = await Promise.all([
    execute('vscode.testing.getTestsInFile', uri),
    provide('vscode.executeDocumentSymbolProvider', uri),
  ]);
  const file = relativePath(uri);
  if (!ids.length) {
    return `No discovered tests in ${file}. Run refresh_tests, or check that a test extension handles this file.`;
  }
  const outline = testOutline(symbols);
  return outline.length
    ? [`Tests in ${file}:`, ...outline].join('\n')
    : `${file} is in the Test Explorer, but no describe/it/test blocks are in its outline yet; the language server may still be loading. Retry shortly.`;
}

async function describeTestExplorer({ file }) {
  if (file) {
    return describeTestsInFile(file);
  }
  const controllers = await controllersWithTests();
  return controllers.length
    ? `Test controllers with discovered tests: ${controllers.join(', ')}. Pass "file" to list the tests of a file.`
    : 'No tests discovered. Install a test extension (e.g. Vitest, C# Dev Kit) or run refresh_tests.';
}

async function refreshTests() {
  await execute('testing.refreshTests');
  return `Tests refreshed. Controllers with tests: ${(await controllersWithTests()).join(', ') || 'none'}.`;
}

async function runTests({ scope, timeout_seconds }) {
  if (!(await controllersWithTests()).length) {
    throw new Error('No tests discovered. Run refresh_tests first.');
  }
  const { done } = await withTimeout(execute(RUN_COMMANDS[scope]), timeout_seconds * 1000);
  return done
    ? `Test run (${scope}) finished. ${RESULTS_HINT}`
    : `Test run (${scope}) still going after ${timeout_seconds}s; stop it with cancel_test_run.`;
}

function testingTools() {
  return [
    {
      name: 'test_explorer',
      description:
        'Show which test controllers (Vitest, .NET, ...) have discovered tests, or list the describe/it/test blocks of one file with their lines. Test states and results are not readable through the VS Code API.',
      inputSchema: { type: 'object', properties: { file: { ...pathProperty, description: `Test file. ${pathProperty.description}` } } },
      handler: describeTestExplorer,
    },
    {
      name: 'refresh_tests',
      description: 'Refresh the Test Explorer: rediscover the tests of every test controller. Waits until discovery ends.',
      inputSchema: NO_ARGS,
      handler: refreshTests,
    },
    {
      name: 'run_tests',
      description: `Run tests through the Test Explorer, visible to the user, and wait for the run to end. ${RESULTS_HINT}`,
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: Object.keys(RUN_COMMANDS),
            default: 'all',
            description: 'all tests, the tests that failed last, the last run again, or the tests of the active editor file.',
          },
          timeout_seconds: timeoutProperty(600, 'The run keeps going after a timeout.', 1800),
        },
      },
      handler: runTests,
    },
    {
      name: 'cancel_test_run',
      description: 'Cancel the running Test Explorer run.',
      inputSchema: NO_ARGS,
      handler: runThenReply('testing.cancelRun', 'Cancelled the running test run, if there was one.'),
    },
    {
      name: 'clear_test_results',
      description: 'Clear all Test Explorer results.',
      inputSchema: NO_ARGS,
      handler: runThenReply('testing.clearTestResults', 'Test results cleared.'),
    },
  ];
}

module.exports = { testingTools };
