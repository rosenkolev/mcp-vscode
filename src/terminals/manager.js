'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { Run } = require('../runs/run');
const { nextEvent } = require('../shared/async');
const { resolveWorkspacePath } = require('../workspace/paths');

const SHELL_INTEGRATION_TIMEOUT_MS = 10000;
const CD_TIMEOUT_MS = 10000;
const MAX_COMMANDS_PER_TERMINAL = 20;
const NO_SHELL_INTEGRATION =
  'shell integration is not active in this terminal (cmd.exe, an unsupported shell, or "terminal.integrated.shellIntegration.enabled" is off)';

/** One command line run in a terminal through shell integration. */
class TerminalRun extends Run {
  constructor(terminal, command) {
    super(`${terminal.name} > ${command}`);
    this.terminal = terminal;
    this.command = command;
  }
}

/** Resolves with the terminal's shell integration once its shell has started, or undefined on timeout. */
async function shellIntegrationOf(terminal) {
  if (terminal.shellIntegration) {
    return terminal.shellIntegration;
  }
  const event = await nextEvent(
    vscode.window.onDidChangeTerminalShellIntegration,
    (candidate) => candidate.terminal === terminal,
    SHELL_INTEGRATION_TIMEOUT_MS,
  );
  return event?.shellIntegration;
}

function isSamePath(a, b) {
  return a !== undefined && path.relative(a, b) === '';
}

const terminalByName = (name) => vscode.window.terminals.find((terminal) => terminal.name === name);

/** Quoted names of the open terminals, for error messages. */
function openTerminalNames() {
  return vscode.window.terminals.map((terminal) => `"${terminal.name}"`).join(', ') || 'none';
}

/** Runs commands in named terminals and captures every shell-integrated command, including typed ones. */
class TerminalManager {
  constructor() {
    /** Captured commands per terminal, oldest first. @type {Map<vscode.Terminal, TerminalRun[]>} */
    this.history = new Map();
    /** Runs started here whose execution has not started yet. @type {Map<vscode.TerminalShellExecution, TerminalRun>} */
    this.pending = new Map();
    /** Exit-code receivers of running executions. @type {Map<vscode.TerminalShellExecution, (exitCode?: number) => void>} */
    this.exits = new Map();
    this.disposables = [
      vscode.window.onDidStartTerminalShellExecution(({ terminal, execution }) => this.capture(terminal, execution)),
      vscode.window.onDidEndTerminalShellExecution(({ execution, exitCode }) => {
        this.exits.get(execution)?.(exitCode);
        this.exits.delete(execution);
      }),
      vscode.window.onDidCloseTerminal((terminal) => this.forget(terminal)),
    ];
  }

  /** Mirrors an execution's output into its run, which ends once the output is drained and the exit code known. */
  async capture(terminal, execution) {
    const run = this.pending.get(execution) ?? this.record(new TerminalRun(terminal, execution.commandLine.value));
    this.pending.delete(execution);
    const exitCode = new Promise((resolve) => this.exits.set(execution, resolve));
    run.setRunning();
    try {
      // read() must be called right away, or the start of the output is lost.
      for await (const data of execution.read()) {
        run.append(data);
      }
      run.finish('exited', await exitCode);
    } catch {
      run.finish('failed');
    } finally {
      this.exits.delete(execution);
    }
  }

  record(run) {
    const runs = this.history.get(run.terminal) ?? [];
    runs.push(run);
    runs.splice(0, Math.max(runs.length - MAX_COMMANDS_PER_TERMINAL, 0)).forEach((dropped) => dropped.dispose());
    this.history.set(run.terminal, runs);
    return run;
  }

  forget(terminal) {
    for (const run of this.history.get(terminal) ?? []) {
      run.finish('terminated');
      run.dispose();
    }
    this.history.delete(terminal);
  }

  latest(terminal) {
    return this.history.get(terminal)?.at(-1);
  }

  execute(terminal, shellIntegration, command) {
    const run = this.record(new TerminalRun(terminal, command));
    this.pending.set(shellIntegration.executeCommand(command), run);
    return run;
  }

  /**
   * Runs `command` in the terminal named `name`, created in `cwd` when missing; an existing terminal
   * changes to `cwd` first. Returns the run, or the reason the command was sent without capture.
   * @returns {Promise<{ run?: TerminalRun, reason?: string }>}
   */
  async run({ command, cwd, terminal: name }) {
    const directory = cwd && resolveWorkspacePath(cwd);
    // A shell started in a missing directory never reports shell integration, so fail early instead.
    if (directory && !(await fs.stat(directory).catch(() => undefined))?.isDirectory()) {
      throw new Error(`No directory at ${directory}.`);
    }
    let terminal = terminalByName(name);
    const busy = terminal && this.latest(terminal);
    if (busy && !busy.ended) {
      throw new Error(
        `Terminal "${name}" is still running "${busy.command}". Use another terminal name, or wait for it with read_terminal.`,
      );
    }
    const changeDirectory =
      terminal && directory && !isSamePath(terminal.shellIntegration?.cwd?.fsPath, directory)
        ? `cd "${directory}"`
        : undefined;
    terminal ??= vscode.window.createTerminal({ name, cwd: directory });
    terminal.show(true);

    const shellIntegration = await shellIntegrationOf(terminal);
    if (!shellIntegration) {
      [changeDirectory, command].filter(Boolean).forEach((line) => terminal.sendText(line));
      return { reason: NO_SHELL_INTEGRATION };
    }
    if (changeDirectory) {
      const cd = this.execute(terminal, shellIntegration, changeDirectory);
      await cd.waitFor({ timeoutMs: CD_TIMEOUT_MS });
      if (cd.exitCode) {
        throw new Error(`${changeDirectory} failed with exit code ${cd.exitCode}: ${cd.lines.join(' ')}`);
      }
    }
    return { run: this.execute(terminal, shellIntegration, command) };
  }

  /** Latest captured command of a terminal; with `commandFilter`, the latest whose command line contains it. */
  find(name, commandFilter) {
    const terminal = this.terminalNamed(name);
    const needle = commandFilter?.toLowerCase();
    const run = (this.history.get(terminal) ?? []).findLast(
      (candidate) => !needle || candidate.command.toLowerCase().includes(needle),
    );
    if (!run) {
      const what = needle ? `command containing "${commandFilter}"` : 'command';
      throw new Error(
        `No ${what} captured in terminal "${name}". Only commands run with shell integration since the extension started are captured.`,
      );
    }
    return run;
  }

  list() {
    return vscode.window.terminals.map((terminal) => ({ terminal, latest: this.latest(terminal) }));
  }

  /** Clears the terminal's screen and drops its finished commands. */
  async clear(name) {
    const terminal = this.terminalNamed(name);
    const previous = vscode.window.activeTerminal;
    terminal.show(true);
    await vscode.commands.executeCommand('workbench.action.terminal.clear');
    if (previous && previous !== terminal) {
      previous.show(true);
    }
    const runs = this.history.get(terminal) ?? [];
    runs.filter((run) => run.ended).forEach((run) => run.dispose());
    this.history.set(terminal, runs.filter((run) => !run.ended));
  }

  terminalNamed(name) {
    const terminal = terminalByName(name);
    if (!terminal) {
      throw new Error(`No terminal "${name}". Open terminals: ${openTerminalNames()}.`);
    }
    return terminal;
  }

  dispose() {
    [...this.history.values()].flat().forEach((run) => run.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { TerminalManager, openTerminalNames };
