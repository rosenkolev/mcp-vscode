'use strict';

const vscode = require('vscode');
const { Run } = require('../runs/run');
const { nextEvent } = require('../shared/async');
const { messageOf, killTree, toSpawnSpec, toCapturedTask } = require('./process');

const STOP_TIMEOUT_MS = 10000;

/** @param {vscode.Task} task */
function folderOf(task) {
  return typeof task.scope === 'object' ? task.scope : undefined;
}

/** The label VS Code shows in "Run Task", e.g. `npm: build` for a detected npm script. */
function labelOf(task) {
  return task.source && task.source !== 'Workspace' ? `${task.source}: ${task.name}` : task.name;
}

function keyOf(task) {
  return `${folderOf(task)?.name ?? ''}::${labelOf(task)}`;
}

const TERMINAL_NAME_PREFIX = /^(Task - |Workspace: )/;
const TERMINAL_NAME_FOLDER_SUFFIX = / \([^)]*\)$/;

/**
 * Whether `name` is one VS Code gives the terminal of `run`: the label, optionally prefixed with
 * "Task - " or, for a task of the .code-workspace file, "Workspace: ", and followed by "(folder)".
 */
function isTerminalOf(run, name) {
  return name.replace(TERMINAL_NAME_PREFIX, '').replace(TERMINAL_NAME_FOLDER_SUFFIX, '') === run.label;
}

function isInFolder(candidate, folderName) {
  return !folderName || (candidate.folderName ?? '').toLowerCase() === folderName.toLowerCase();
}

/** "label [folder]", which tells apart tasks of the same label in a multi-root workspace. */
function labelWithFolder(candidate) {
  return `${candidate.label} [${candidate.folderName ?? 'workspace'}]`;
}

/**
 * Picks the one candidate (a task entry or a run) whose label, or failing that whose bare name,
 * equals `name`. `notFound` builds the error message when nothing matches.
 */
function pickByName(candidates, name, notFound) {
  const needle = name.trim().toLowerCase();
  const byLabel = candidates.filter((candidate) => candidate.label.toLowerCase() === needle);
  const matches = byLabel.length ? byLabel : candidates.filter((candidate) => candidate.name.toLowerCase() === needle);
  if (!matches.length) {
    throw new Error(notFound());
  }
  if (matches.length > 1) {
    throw new Error(`"${name}" matches several: ${matches.map(labelWithFolder).join(', ')}. Pass "folder" to pick one.`);
  }
  return matches[0];
}

/**
 * Resolves once VS Code reports the end of `execution`, or on timeout. A captured run ends when its
 * process exits, which is before VS Code ends the task.
 */
async function taskEndOf(execution) {
  if (execution && vscode.tasks.taskExecutions.includes(execution)) {
    await nextEvent(vscode.tasks.onDidEndTask, (event) => event.execution === execution, STOP_TIMEOUT_MS);
  }
}

class TaskRun extends Run {
  /**
   * @param {vscode.Task} task
   * @param {string} [uncapturedReason] set for runs VS Code executes itself
   */
  constructor(task, uncapturedReason) {
    super(labelOf(task));
    this.key = keyOf(task);
    this.name = task.name;
    this.folderName = folderOf(task)?.name;
    this.uncapturedReason = uncapturedReason;
    this.stopRequested = false;
    /** @type {vscode.TaskExecution | undefined} */
    this.execution = undefined;
    /** Process of a captured run. @type {import('child_process').ChildProcess | undefined} */
    this.child = undefined;
  }
}

class TaskRunner {
  constructor(log) {
    this.log = log;
    /** Latest run per task key. @type {Map<string, TaskRun>} */
    this.runs = new Map();
    /** Task terminal per task key; VS Code reuses it for later runs of the same task. @type {Map<string, vscode.Terminal>} */
    this.terminals = new Map();
    this.disposables = [
      vscode.window.onDidOpenTerminal((terminal) => this.adoptTerminal(terminal)),
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [key, candidate] of this.terminals) {
          if (candidate === terminal) {
            this.terminals.delete(key);
          }
        }
      }),
      vscode.tasks.onDidStartTask(({ execution }) => this.track(execution)),
      vscode.tasks.onDidStartTaskProcess(({ execution, processId }) => this.nativeRun(execution)?.setRunning(processId)),
      vscode.tasks.onDidEndTaskProcess(({ execution, exitCode }) => {
        const run = this.nativeRun(execution);
        if (run) {
          run.exitCode = exitCode;
        }
      }),
      vscode.tasks.onDidEndTask(({ execution }) => {
        const run = this.liveRun(execution);
        if (!run) {
          return;
        }
        if (!run.captured) {
          run.finish(run.stopRequested ? 'terminated' : 'exited', run.exitCode);
        } else if (run.state === 'starting') {
          run.finish('failed');
        }
      }),
    ];
    vscode.tasks.taskExecutions.forEach((execution) => this.track(execution));
  }

  /** Live run of an execution; events of an earlier execution of the same task (a restart) are not its own. */
  liveRun(execution) {
    const run = this.runs.get(keyOf(execution.task));
    return run && !run.ended && (!run.execution || run.execution === execution) ? run : undefined;
  }

  /** Live run that VS Code executes itself, so its state comes from task events. */
  nativeRun(execution) {
    const run = this.liveRun(execution);
    return run?.captured ? undefined : run;
  }

  /** Makes `run` the latest run of its task. A replaced live run is not disposed, so its waiters still finish. */
  setLatest(run) {
    const previous = this.runs.get(run.key);
    if (previous?.ended) {
      previous.dispose();
    }
    this.runs.set(run.key, run);
  }

  /** Attaches an execution to its run, or tracks a task started from the VS Code UI. */
  track(execution) {
    const run = this.liveRun(execution);
    if (run) {
      run.execution ??= execution;
      // VS Code starts a native run only once its ${input:...} prompts are answered.
      if (!run.captured) {
        run.setRunning();
      }
      return;
    }
    const external = new TaskRun(execution.task, 'the task was started outside MCP VS Code');
    external.execution = execution;
    external.setRunning();
    this.setLatest(external);
  }

  /** Tasks VS Code can run, one per key, as `{ task, key, label, name, folderName }`. */
  async availableTasks(folderName) {
    const entries = new Map();
    for (const task of await vscode.tasks.fetchTasks()) {
      const entry = { task, key: keyOf(task), label: labelOf(task), name: task.name, folderName: folderOf(task)?.name };
      if (isInFolder(entry, folderName) && !entries.has(entry.key)) {
        entries.set(entry.key, entry);
      }
    }
    return [...entries.values()];
  }

  async listTasks(filter, folderName) {
    const needle = filter?.toLowerCase();
    const entries = await this.availableTasks(folderName);
    return entries
      .filter((entry) => !needle || entry.label.toLowerCase().includes(needle))
      .map((entry) => ({ ...entry, run: this.runs.get(entry.key) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  async findTask(name, folderName) {
    const entries = await this.availableTasks(folderName);
    const entry = pickByName(entries, name, () => {
      const needle = name.trim().toLowerCase();
      const similar = entries
        .filter((candidate) => candidate.label.toLowerCase().includes(needle))
        .slice(0, 15)
        .map(labelWithFolder);
      const hint = similar.length ? ` Similar: ${similar.join(', ')}.` : ' Use list_tasks to see the available tasks.';
      return `No task "${name}"${folderName ? ` in folder "${folderName}"` : ''}.${hint}`;
    });
    return entry.task;
  }

  /** Finds a tracked run by task label or name. */
  findRun(name, folderName) {
    const runs = [...this.runs.values()].filter((run) => isInFolder(run, folderName));
    return pickByName(runs, name, () => {
      const tracked = runs.map((run) => run.label).join(', ') || 'none';
      return `No run of "${name}" is tracked (tracked: ${tracked}). Start it with run_task.`;
    });
  }

  trackedRuns() {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  async run(name, { folder, restart, capture }) {
    const task = await this.findTask(name, folder);
    const previous = this.runs.get(keyOf(task));
    if (previous && !previous.ended) {
      if (!restart) {
        throw new Error(
          `"${previous.label}" is already running. Read it with task_status, stop it with close_task, or pass restart: true.`,
        );
      }
      await this.stop(previous);
    }
    // Otherwise the end event of the previous execution would end the new run.
    await taskEndOf(previous?.execution);

    const folderForVariables = folderOf(task) ?? vscode.workspace.workspaceFolders?.[0];
    const { spec, reason } = capture ? toSpawnSpec(task, folderForVariables) : { reason: 'capture: false was requested' };
    const run = new TaskRun(task, reason);
    this.setLatest(run);
    if (reason) {
      this.log.info(`Running "${run.label}" natively: ${reason}`);
    }

    try {
      const execution = await vscode.tasks.executeTask(spec ? toCapturedTask(task, run, spec, this.log) : task);
      run.execution ??= execution;
    } catch (error) {
      run.append(`Failed to start: ${messageOf(error)}\n`);
      run.finish('failed');
      throw error;
    }
    return run;
  }

  async stop(run) {
    if (run.ended) {
      return;
    }
    run.stopRequested = true;
    if (run.child) {
      killTree(run.child);
    } else {
      run.execution?.terminate();
    }
    await run.waitFor({ timeoutMs: STOP_TIMEOUT_MS });
  }

  /**
   * Links a newly opened terminal to the live run it was opened for. VS Code exposes no task-to-terminal
   * link, so the name is matched once here; the kept reference survives later renames.
   */
  adoptTerminal(terminal) {
    const run = [...this.runs.values()].find(
      (candidate) =>
        !candidate.ended && !this.terminals.has(candidate.key) && isTerminalOf(candidate, terminal.name),
    );
    if (run) {
      this.terminals.set(run.key, terminal);
    }
  }

  /** Closes the terminal of a run; falls back to a name match for terminals opened before activation. */
  closeTerminal(run) {
    const terminal =
      this.terminals.get(run.key) ?? vscode.window.terminals.find((candidate) => isTerminalOf(run, candidate.name));
    terminal?.dispose();
    return Boolean(terminal);
  }

  dispose() {
    for (const run of this.runs.values()) {
      if (!run.ended && run.child) {
        killTree(run.child);
      }
      run.dispose();
    }
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { TaskRunner };
