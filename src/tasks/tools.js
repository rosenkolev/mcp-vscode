'use strict';

const { maxLinesProperty, filterProperty } = require('../shared/schema');
const { limitLines } = require('../shared/text');
const { sinceProperty, waitProperties, describeRun, waitAndReport } = require('../runs/report');
const { openTerminalNames } = require('../terminals/manager');

const MAX_LISTED_TASKS = 300;

const nameProperty = {
  type: 'string',
  description:
    'Task label as shown in "Tasks: Run Task", e.g. "npm: build" or "npm: dev - apps/web". A bare task name also matches.',
};
const folderProperty = {
  type: 'string',
  description: 'Workspace folder name, to pick between tasks with the same label in a multi-root workspace.',
};

/** A native run stays in 'starting' while VS Code shows its ${input:...} prompts, which close_task cannot dismiss. */
function pendingStartNotes(run) {
  return !run.captured && run.state === 'starting'
    ? ['Not started yet: VS Code may be waiting for an answer to an input prompt in the window.']
    : [];
}

function formatTaskList(entries) {
  if (!entries.length) {
    return 'No tasks found. npm scripts only appear when the "npm.autoDetect" setting is on.';
  }
  const lines = entries.map(({ task, label, folderName, run }) =>
    [
      label,
      folderName && ` [${folderName}]`,
      task.isBackground && ' (background)',
      run && ` - ${run.state}`,
      task.detail && ` - ${task.detail}`,
    ]
      .filter(Boolean)
      .join(''),
  );
  return limitLines(lines, MAX_LISTED_TASKS, 'narrow with "filter"').join('\n');
}

/** @param {import('./runner').TaskRunner} runner */
function taskTools(runner) {
  return [
    {
      name: 'list_tasks',
      description:
        'List the tasks VS Code can run in the open workspace (tasks.json and auto-detected, e.g. npm scripts), with the state of any tracked run.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Case-insensitive substring of the task label.' },
          folder: folderProperty,
        },
      },
      handler: async ({ filter, folder }) => formatTaskList(await runner.listTasks(filter, folder)),
    },
    {
      name: 'run_task',
      description:
        'Start a VS Code task in its own terminal, visible to the user. Output is captured for task_status, except for tasks VS Code must run itself (dependsOn, ${input:...} variables, custom executions). Returns immediately unless a wait_* argument is set.',
      inputSchema: {
        type: 'object',
        properties: {
          name: nameProperty,
          folder: folderProperty,
          restart: { type: 'boolean', default: false, description: 'Stop the task first if it is already running.' },
          capture: {
            type: 'boolean',
            default: true,
            description: 'Capture output. false runs the task exactly as VS Code would, without output.',
          },
          ...waitProperties(false),
          max_lines: maxLinesProperty,
        },
        required: ['name'],
      },
      handler: async (args) => {
        return waitAndReport(await runner.run(args.name, args), args, 0, pendingStartNotes);
      },
    },
    {
      name: 'task_status',
      description:
        'Report the state, exit code and output of a task run, including tasks the user started in VS Code (state only). Without "name", lists all tracked runs.',
      inputSchema: {
        type: 'object',
        properties: {
          name: nameProperty,
          folder: folderProperty,
          since: sinceProperty,
          filter: filterProperty,
          max_lines: maxLinesProperty,
          ...waitProperties(false),
        },
      },
      handler: async (args) => {
        if (!args.name) {
          const runs = runner.trackedRuns();
          return runs.length ? runs.map(describeRun).join('\n') : 'No task runs tracked yet.';
        }
        const run = runner.findRun(args.name, args.folder);
        return waitAndReport(run, args, args.since ?? run.lineCount);
      },
    },
    {
      name: 'close_task',
      description: 'Stop a running task (its whole process tree) and close its terminal.',
      inputSchema: {
        type: 'object',
        properties: {
          name: nameProperty,
          folder: folderProperty,
          close_terminal: { type: 'boolean', default: true, description: 'Close the task terminal too.' },
        },
        required: ['name'],
      },
      handler: async ({ name, folder, close_terminal }) => {
        const run = runner.findRun(name, folder);
        const wasRunning = !run.ended;
        await runner.stop(run);
        const lines = [describeRun(run)];
        if (wasRunning && !run.ended) {
          lines.push('The task did not stop in time.', ...pendingStartNotes(run));
        }
        if (close_terminal) {
          lines.push(
            runner.closeTerminal(run)
              ? 'Terminal closed.'
              : `No terminal of this task was found to close. Open terminals: ${openTerminalNames()}.`,
          );
        }
        return lines.join('\n');
      },
    },
  ];
}

module.exports = { taskTools };
