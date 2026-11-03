'use strict';

const vscode = require('vscode');
const path = require('path');
const { sleep, withTimeout } = require('../shared/async');
const { NO_ARGS, pathProperty, timeoutProperty } = require('../shared/schema');
const { existingUri, relativePath } = require('../workspace/paths');
const { limitLines, plural } = require('../shared/text');
const vscodeUnofficial = require('../unofficial/vscode-unofficial');
const { ID_SEPARATOR, lastIdPart } = require('../unofficial/test-results');

/** Run profile groups of the Test Explorer, as `vscode.runTestsById` takes them. */
const RUN_GROUP = 2;
const COVERAGE_GROUP = 8;
/** How long to wait for the tests of a file once the Testing view shows them. */
const EXPAND_ATTEMPTS = 10;
const EXPAND_POLL_MS = 300;

/**
 * Built-in Test Explorer commands per run_tests scope, without and with coverage; each resolves when its
 * run ends. "file" commands take the file, "test" commands act at the editor's cursor, and "tests" runs
 * the chosen tests by id.
 */
const RUN_COMMANDS = {
  all: { run: 'testing.runAll', coverage: 'testing.coverageAll' },
  failed: { run: 'testing.reRunFailTests' },
  last: { run: 'testing.reRunLastRun', coverage: 'testing.coverageLastRun' },
  file: { run: 'testing.runCurrentFile', coverage: 'testing.coverageCurrentFile', needs: ['path'] },
  test: { run: 'testing.runAtCursor', coverage: 'testing.coverageAtCursor', needs: ['path', 'line'] },
  tests: { run: 'vscode.runTestsById', coverage: 'vscode.runTestsById', needs: ['path', 'names'] },
};
const RESULTS_HINT = 'Results are in the Test Explorer; run the test command with run_in_terminal for readable output.';
/** VS Code stores which tests failed, but not why. */
const FAILURE_HINT = 'Failure messages are not stored by VS Code: run a failed test file with run_in_terminal for the details.';
const COVERAGE_HINT = 'Coverage was collected: VS Code shows it in the editor and the Test Coverage view. Its numbers are not readable.';
const NO_COVERAGE_HINT = 'No coverage was collected: the test extension has no coverage run, or it is not set up (e.g. a coverage package is missing).';

const execute = (command, ...args) => vscode.commands.executeCommand(command, ...args);
const controllersWithTests = () => execute('vscode.testing.getControllersWithTests');

/** Handler that runs a command and replies with a fixed text. */
const runThenReply = (command, reply) => async () => {
  await execute(command);
  return reply;
};

const normalized = (text) => text.trim().toLowerCase();

/** Names, lines and last states of tests, by id, from the stored results, the newest first; empty when unreadable. */
async function knownTests() {
  const results = await vscodeUnofficial.testResults.read().catch(() => []);
  const known = new Map();
  for (const result of results) {
    for (const test of result.tests) {
      if (!known.has(test.id)) {
        known.set(test.id, test);
      }
    }
  }
  return known;
}

/**
 * Ids of the tests VS Code knows in a file. Some controllers (Vitest) discover a file only once it is
 * open, and VS Code fetches the tests of a test folder or file only once something expands it, as the
 * Testing view does; so when none are known, the file is opened and the view shown, keeping the focus.
 */
async function testIdsInFile(uri) {
  const ids = await execute('vscode.testing.getTestsInFile', uri);
  if (ids.length) {
    return ids;
  }
  await vscode.workspace.openTextDocument(uri);
  await execute('workbench.view.testing.focus');
  await execute('workbench.action.focusActiveEditorGroup');
  for (let attempt = 0; attempt < EXPAND_ATTEMPTS; attempt++) {
    const found = await execute('vscode.testing.getTestsInFile', uri);
    if (found.length) {
      return found;
    }
    await sleep(EXPAND_POLL_MS);
  }
  return [];
}

/**
 * The tests discovered in a file, as `{ id, name, line, state }`: only the innermost items (tests, not
 * their suites). Names and lines come from earlier results. A test that never ran is named by the last
 * part of its id, as VS Code keeps test labels only in memory until a run stores them.
 */
async function discoveredTests(uri) {
  const [parts, known] = await Promise.all([testIdsInFile(uri), knownTests()]);
  const ids = parts.map((segments) => segments.join(ID_SEPARATOR));
  const parents = new Set(ids.map((id) => id.slice(0, Math.max(id.lastIndexOf(ID_SEPARATOR), 0))));
  return ids
    .filter((id) => !parents.has(id))
    .map((id) => {
      const test = known.get(id);
      return { id, name: test?.name ?? lastIdPart(id), line: test?.line, state: test?.state };
    })
    .sort((a, b) => (a.line ?? Infinity) - (b.line ?? Infinity));
}

async function describeTestsInFile(input) {
  const uri = await existingUri(input);
  const file = relativePath(uri);
  const tests = await discoveredTests(uri);
  if (!tests.length) {
    return `No discovered tests in ${file}. Run refresh_tests, or check that a test extension handles this file.`;
  }
  // Some extensions (Vitest) list only the file until it runs; such an item's id ends with the file's name.
  if (tests.every((test) => !test.state && normalized(test.name).endsWith(normalized(path.basename(uri.fsPath))))) {
    return `${file} is in the Test Explorer; its extension lists the tests in it once the file runs (run_tests, scope "file").`;
  }
  const lines = tests.map(
    ({ name, line, state }) => `  ${name}${line ? ` (line ${line})` : ''} - ${state ? `last run: ${state}` : 'not run yet'}`,
  );
  const neverRan = tests.some((test) => !test.state) ? ' Tests that never ran show their id; any unique part of it works as a name.' : '';
  return [
    `${plural(tests.length, 'test')} discovered in ${file}:`,
    ...lines,
    `Run some of them with run_tests, scope "tests" and their names.${neverRan}`,
  ].join('\n');
}

async function describeTestExplorer({ file }) {
  if (file) {
    return describeTestsInFile(file);
  }
  const controllers = await controllersWithTests();
  if (!controllers.length) {
    return 'No tests discovered. Install a test extension (e.g. Vitest, Jest, Python, C# Dev Kit) or run refresh_tests.';
  }
  const known = [...(await knownTests()).values()];
  const files = [...new Set(known.map((test) => test.file).filter(Boolean))].map((testFile) => relativePath(testFile)).sort();
  return [
    `Test controllers with discovered tests: ${controllers.join(', ')}.`,
    ...(files.length ? [`Test files of earlier runs: ${files.join(', ')}.`] : []),
    'Pass "file" to list the tests of a file.',
  ].join('\n');
}

/** Throws when more than one test answers to `name`; a run never takes a guess. */
function onlyOne(name, tests) {
  if (tests.length > 1) {
    throw new Error(`"${name}" matches ${tests.length} tests: ${tests.map((test) => `"${test.name}"`).join(', ')}. Use a longer name.`);
  }
  return tests;
}

/**
 * The test one name selects, case-insensitive: the one whose name, or the last part of its name path, is
 * exactly the name; else the one whose name or own id part contains it, whatever form the extension gives
 * its ids. A name more than one test answers to selects none.
 */
function selectByName(tests, name) {
  const wanted = normalized(name);
  const exact = tests.filter((test) => normalized(test.name) === wanted || normalized(test.name.split(' > ').pop()) === wanted);
  if (exact.length) {
    return onlyOne(name, exact);
  }
  return onlyOne(name, tests.filter((test) => normalized(test.name).includes(wanted) || normalized(lastIdPart(test.id)).includes(wanted)));
}

/** Ids of the tests of `uri` that `names` select; throws for a name that selects none. */
async function testIdsByName(uri, names) {
  const tests = await discoveredTests(uri);
  const selected = names.map((name) => ({ name, tests: selectByName(tests, name) }));
  const missing = selected.filter((entry) => !entry.tests.length).map(({ name }) => `"${name}"`);
  if (missing.length) {
    const available = tests.map((test) => `"${test.name}"`).join(', ') || 'none';
    throw new Error(`No test named ${missing.join(', ')} in ${relativePath(uri)}. Discovered: ${available}.`);
  }
  return [...new Set(selected.flatMap((entry) => entry.tests.map((test) => test.id)))];
}

async function refreshTests() {
  await execute('testing.refreshTests');
  return `Tests refreshed. Controllers with tests: ${(await controllersWithTests()).join(', ') || 'none'}.`;
}

const STATE_ORDER = ['errored', 'failed', 'passed', 'skipped', 'queued', 'running', 'unset'];
const MAX_TESTS_LISTED = 100;

function formatDuration(milliseconds) {
  return milliseconds < 1000 ? `${Math.round(milliseconds)}ms` : `${(milliseconds / 1000).toFixed(1)}s`;
}

function describeTest(test) {
  const where = test.file ? ` - ${relativePath(test.file)}${test.line ? `:${test.line}` : ''}` : '';
  return `  ${test.state}: ${test.name}${where}${test.durationMs === undefined ? '' : ` (${formatDuration(test.durationMs)})`}`;
}

/** A stored test result: counts by state, then the tests of the `show` states, failures first. */
function describeResult(result, { show }) {
  const counts = STATE_ORDER.map((state) => [state, result.tests.filter((test) => test.state === state).length]).filter(([, count]) => count);
  const testTime = result.tests.reduce((sum, test) => sum + (test.durationMs ?? 0), 0);
  const summary = counts.map(([state, count]) => `${count} ${state}`).join(', ') || 'no tests ran';
  const lines = [`Test run ${new Date(result.completedAt).toLocaleString()}: ${summary}${testTime ? `; tests took ${formatDuration(testTime)}` : ''}.`];
  const listed = result.tests
    .filter((test) => show === 'all' || ['failed', 'errored'].includes(test.state))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  lines.push(...limitLines(listed.map(describeTest), MAX_TESTS_LISTED, 'pass a narrower run'));
  if (listed.some((test) => ['failed', 'errored'].includes(test.state))) {
    lines.push(FAILURE_HINT);
  }
  if (result.hasCoverage) {
    lines.push(COVERAGE_HINT);
  }
  return lines.join('\n');
}

/**
 * Puts the editor's cursor on `line` of the file, for the commands that run the test at the cursor. The
 * keyboard focus stays where the user has it.
 */
async function showAt(uri, line) {
  const document = await vscode.workspace.openTextDocument(uri);
  if (line > document.lineCount) {
    throw new Error(`Line ${line} is past the end of ${relativePath(uri)} (${document.lineCount} lines).`);
  }
  // At the end of the line's text, not its start: some extensions (Vitest) start a test's range after it.
  const position = new vscode.Position(line - 1, document.lineAt(line - 1).text.trimEnd().length);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preserveFocus: true });
}

/** The command that runs `scope`, after checking that the arguments it needs are there. */
function commandOf(args) {
  const { scope, coverage } = args;
  const { needs = [], ...commands } = RUN_COMMANDS[scope];
  const missing = needs.filter((name) => args[name] === undefined || (Array.isArray(args[name]) && !args[name].length));
  if (missing.length) {
    throw new Error(`scope "${scope}" needs ${missing.map((name) => `"${name}"`).join(' and ')}.`);
  }
  if (coverage && !commands.coverage) {
    throw new Error(`scope "${scope}" cannot collect coverage; use "all", "last", "file", "test" or "tests".`);
  }
  return coverage ? commands.coverage : commands.run;
}

/** A function that starts the run of `scope`, prepared up front so a wrong argument fails before anything runs. */
async function prepareRun(command, { scope, coverage, path: testFile, line, names }) {
  if (scope === 'tests') {
    const ids = await testIdsByName(await existingUri(testFile), names);
    return () => execute(command, coverage ? COVERAGE_GROUP : RUN_GROUP, ...ids);
  }
  if (scope === 'file') {
    // The run-current-file commands take a list of files instead of the active editor.
    const uri = await existingUri(testFile);
    return () => execute(command, [uri]);
  }
  if (scope === 'test') {
    await showAt(await existingUri(testFile), line);
  }
  return () => execute(command);
}

async function runTests({ timeout_seconds, ...args }) {
  const { scope, coverage } = args;
  const command = commandOf(args);
  if (!(await controllersWithTests()).length) {
    throw new Error('No tests discovered. Run refresh_tests first.');
  }
  const run = await prepareRun(command, args);
  // The results stored before the run, so that the new one is this run's, not one the user started.
  const before = await vscodeUnofficial.testResults.ids().catch(() => undefined);
  const { done } = await withTimeout(run(), timeout_seconds * 1000);
  if (!done) {
    return `Test run (${scope}) still going after ${timeout_seconds}s; stop it with cancel_test_run, or read it later with test_results.`;
  }
  try {
    const result = before && (await vscodeUnofficial.testResults.after(before));
    if (!result) {
      return `Test run (${scope}) finished, but no new result was stored: it may have had nothing to run (e.g. no failed tests to rerun), or the extension does not keep its results. If tests did run, read them with test_results.`;
    }
    const missingCoverage = coverage && !result.hasCoverage ? `\n${NO_COVERAGE_HINT}` : '';
    return `${describeResult(result, args)}${missingCoverage}`;
  } catch (error) {
    return `Test run (${scope}) finished. Results not readable: ${error.message} ${RESULTS_HINT}`;
  }
}

async function testResults(args) {
  const result = await vscodeUnofficial.testResults.latest();
  return result ? describeResult(result, args) : 'No test results yet. Run tests with run_tests.';
}

const resultProperties = {
  show: {
    type: 'string',
    enum: ['failed', 'all'],
    default: 'failed',
    description: 'List only the failed and errored tests, or every test.',
  },
};

function testingTools() {
  return [
    {
      name: 'test_explorer',
      description:
        'Show which test controllers (Vitest, Jest, pytest, .NET, ...) have discovered tests, or list the tests discovered in one file, with their line and last result once they ran. Results of runs: test_results.',
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
      description:
        'Run tests through the Test Explorer, visible to the user, wait for the run to end, and return the result: counts by state, and the failed tests with their file and line. "coverage": true collects coverage, which VS Code shows in the editor.',
      inputSchema: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            enum: Object.keys(RUN_COMMANDS),
            default: 'all',
            description:
              'all tests; the tests that failed last; the last run again; the tests of one file ("path"); one test ("path" and a "line" inside it); or tests of a file by name ("path" and "names").',
          },
          path: { ...pathProperty, description: `Test file, for scope "file", "test" or "tests". ${pathProperty.description}` },
          line: { type: 'integer', minimum: 1, description: 'For scope "test": a line inside the test to run (1-based).' },
          names: {
            type: 'array',
            items: { type: 'string' },
            description:
              'For scope "tests": test names as test_explorer lists them for the file, e.g. "math > adds" or just "adds"; any unique part of a name or id also works.',
          },
          coverage: { type: 'boolean', default: false, description: 'Run with coverage, when the test extension supports it.' },
          ...resultProperties,
          timeout_seconds: timeoutProperty(600, 'The run keeps going after a timeout.', 1800),
        },
      },
      handler: runTests,
    },
    {
      name: 'test_results',
      description:
        'The result of the latest Test Explorer run, also one the user started: counts by state, and the failed tests (or all) with their file, line and duration. Failure messages are not stored by VS Code.',
      inputSchema: { type: 'object', properties: resultProperties },
      handler: testResults,
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
