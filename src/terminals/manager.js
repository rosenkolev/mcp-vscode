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
const MAX_CLOSED_TERMINALS = 20;
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
    /** Terminals closed here, by close_terminal or once their command ended. @type {Set<vscode.Terminal>} */
    this.closedHere = new Set();
    /** Captured commands of terminals closed here, per name, still readable with read_terminal. @type {Map<string, TerminalRun[]>} */
    this.closedHistory = new Map();
    /** Command being started per terminal name, until it is captured. @type {Map<string, string>} */
    this.reserved = new Map();
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

  /** Keeps `run` in its terminal's history, dropping the oldest ended runs beyond the limit. */
  record(run) {
    const runs = this.history.get(run.terminal) ?? [];
    runs.push(run);
    const excess = runs.length - MAX_COMMANDS_PER_TERMINAL;
    // Only ended runs are dropped: a live run still has waiters and an auto-close listener on it.
    runs.filter((candidate) => candidate.ended).slice(0, Math.max(excess, 0)).forEach((dropped) => {
      runs.splice(runs.indexOf(dropped), 1);
      dropped.dispose();
    });
    this.history.set(run.terminal, runs);
    return run;
  }

  forget(terminal) {
    const runs = this.history.get(terminal) ?? [];
    this.history.delete(terminal);
    this.reserved.delete(terminal.name);
    for (const [execution, run] of this.pending) {
      if (run.terminal === terminal) {
        this.pending.delete(execution);
      }
    }
    runs.forEach((run) => run.finish('terminated'));
    if (this.closedHere.delete(terminal)) {
      this.closedHistory.get(terminal.name)?.forEach((run) => run.dispose());
      this.closedHistory.delete(terminal.name);
      this.closedHistory.set(terminal.name, runs);
      const excess = this.closedHistory.size - MAX_CLOSED_TERMINALS;
      [...this.closedHistory.keys()].slice(0, Math.max(excess, 0)).forEach((name) => {
        this.closedHistory.get(name).forEach((run) => run.dispose());
        this.closedHistory.delete(name);
      });
      return;
    }
    runs.forEach((run) => run.dispose());
  }

  /** Closes the terminal once `run` ends; its commands stay readable by terminal name. */
  closeWhenEnded(run) {
    const close = () => {
      if (!vscode.window.terminals.includes(run.terminal)) {
        return;
      }
      this.closedHere.add(run.terminal);
      run.terminal.dispose();
    };
    if (run.ended) {
      close();
      return;
    }
    const subscription = run.changed.event(() => {
      if (run.ended) {
        subscription.dispose();
        close();
      }
    });
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
   * changes to `cwd` first. The terminal closes once the command ends, unless `keep_open`. Returns the
   * run, or the reason the command was sent without capture.
   * @returns {Promise<{ run?: TerminalRun, reason?: string }>}
   */
  async run({ command, cwd, terminal: name, keep_open }) {
    const directory = cwd && resolveWorkspacePath(cwd);
    // A shell started in a missing directory never reports shell integration, so fail early instead.
    if (directory && !(await fs.stat(directory).catch(() => undefined))?.isDirectory()) {
      throw new Error(`No directory at ${directory}.`);
    }
    let terminal = this.liveTerminal(name);
    const latest = terminal && this.latest(terminal);
    const busy = this.reserved.get(name) ?? (latest && !latest.ended ? latest.command : undefined);
    if (busy !== undefined) {
      throw new Error(`Terminal "${name}" is still running "${busy}". Use another terminal name, or wait for it with read_terminal.`);
    }
    // Reserved until the command is captured, so a second call during the shell start cannot share the terminal.
    this.reserved.set(name, command);
    try {
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
        const { reason } = await cd.waitFor({ timeoutMs: CD_TIMEOUT_MS });
        if (reason === 'timeout' || cd.exitCode) {
          const outcome = reason === 'timeout' ? `did not finish within ${CD_TIMEOUT_MS / 1000}s` : `failed with exit code ${cd.exitCode}`;
          throw new Error(`${changeDirectory} ${outcome}: ${cd.lines.join(' ')}`);
        }
      }
      const run = this.execute(terminal, shellIntegration, command);
      if (!keep_open) {
        this.closeWhenEnded(run);
      }
      return { run };
    } finally {
      this.reserved.delete(name);
    }
  }

  /**
   * Latest captured command of a terminal, or of the last auto-closed terminal of that name; with
   * `commandFilter`, the latest whose command line contains it.
   */
  find(name, commandFilter) {
    // A terminal still closing keeps its commands until VS Code reports the close.
    const terminal = this.liveTerminal(name) ?? terminalByName(name);
    const runs = terminal ? this.history.get(terminal) : this.closedHistory.get(name);
    if (!terminal && !runs) {
      throw new Error(`No terminal "${name}". Open terminals: ${openTerminalNames()}.`);
    }
    const needle = commandFilter?.toLowerCase();
    const run = (runs ?? []).findLast(
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
    return vscode.window.terminals
      .filter((terminal) => !this.closedHere.has(terminal))
      .map((terminal) => ({ terminal, latest: this.latest(terminal) }));
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

  /**
   * Types `text` into a terminal, e.g. an answer to a prompt; `interrupt` presses Ctrl+C first. Returns the
   * run that receives the input, if one is running.
   */
  send(name, { text, enter, interrupt }) {
    const terminal = this.terminalNamed(name);
    if (interrupt) {
      terminal.sendText('\x03', false);
    }
    if (text !== undefined) {
      terminal.sendText(text, enter);
    }
    const latest = this.latest(terminal);
    return latest && !latest.ended ? latest : undefined;
  }

  /** Closes a terminal, which ends what runs in it; its captured commands stay readable by its name. */
  close(name) {
    const terminal = this.terminalNamed(name);
    const running = this.latest(terminal);
    this.closedHere.add(terminal);
    terminal.dispose();
    return running && !running.ended ? running : undefined;
  }

  /**
   * The open terminal named `name`. A terminal closed here, or whose shell exited, stays listed until VS
   * Code reports the close, and is skipped, so a new command with the same name gets a new terminal.
   */
  liveTerminal(name) {
    return vscode.window.terminals.findLast(
      (terminal) => terminal.name === name && !this.closedHere.has(terminal) && !terminal.exitStatus,
    );
  }

  terminalNamed(name) {
    const terminal = this.liveTerminal(name);
    if (!terminal) {
      throw new Error(`No terminal "${name}". Open terminals: ${openTerminalNames()}.`);
    }
    return terminal;
  }

  dispose() {
    [...this.history.values(), ...this.closedHistory.values()].flat().forEach((run) => run.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { TerminalManager, openTerminalNames };
