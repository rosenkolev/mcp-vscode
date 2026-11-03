'use strict';

/*
 * A test controller for the live tests, so the Test Explorer tools have tests to run without a real test
 * extension. Its tests live in a/calc.js of the fixture workspace: "adds" passes, "subtracts" fails, and
 * "skipped" is skipped. Each run prints a line of output, as test extensions do.
 */

const vscode = require('vscode');

const TESTS = [
  { id: 'adds', line: 3, outcome: 'passed' },
  { id: 'subtracts', line: 7, outcome: 'failed' },
  { id: 'skipped', line: 14, outcome: 'skipped' },
];

function activate(context) {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === 'a');
  if (!folder) {
    return;
  }
  const controller = vscode.tests.createTestController('fixture', 'Fixture tests');
  context.subscriptions.push(controller);
  const uri = vscode.Uri.joinPath(folder.uri, 'calc.js');
  const file = controller.createTestItem('calc', 'calc.js', uri);
  const suite = controller.createTestItem('calc/math', 'math', uri);
  suite.range = new vscode.Range(2, 0, 15, 0);
  for (const { id, line } of TESTS) {
    const test = controller.createTestItem(`calc/math/${id}`, id, uri);
    test.range = new vscode.Range(line - 1, 0, line, 0);
    suite.children.add(test);
  }
  file.children.add(suite);
  controller.items.add(file);

  controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    async (request, token) => {
      const run = controller.createTestRun(request);
      const queue = [];
      const collect = (item) => (item.children.size ? item.children.forEach(collect) : queue.push(item));
      (request.include ?? [file]).forEach(collect);
      run.appendOutput('fixture run started\r\n');
      for (const test of queue) {
        if (token.isCancellationRequested) {
          break;
        }
        const { outcome } = TESTS.find((candidate) => test.id.endsWith(`/${candidate.id}`));
        run.started(test);
        if (outcome === 'passed') {
          run.passed(test, 5);
        } else if (outcome === 'failed') {
          run.failed(test, new vscode.TestMessage('expected 1 to equal 2'), 7);
        } else {
          run.skipped(test);
        }
      }
      run.end();
    },
    true,
  );
}

module.exports = { activate };
