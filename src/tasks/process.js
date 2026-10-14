'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const IS_WINDOWS = process.platform === 'win32';

class UnresolvableVariableError extends Error {}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (IS_WINDOWS) {
    cp.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () =>
      child.kill(),
    );
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Pseudoterminal that runs the task's command itself, mirroring output to the terminal and the run. */
class CapturedPty {
  constructor(run, spec, log) {
    this.run = run;
    this.spec = spec;
    this.log = log;
    this.writeEmitter = new vscode.EventEmitter();
    this.closeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
    this.onDidClose = this.closeEmitter.event;
  }

  open() {
    const { run, spec } = this;
    const commandText = spec.commandLine ?? [spec.file, ...spec.args].join(' ');
    this.writeEmitter.fire(`\x1b[2m> ${commandText}  (${spec.cwd})\x1b[0m\r\n`);
    this.log.info(`Starting "${run.label}": ${commandText} in ${spec.cwd}`);

    const options = {
      cwd: spec.cwd,
      env: { ...process.env, FORCE_COLOR: '1', ...spec.env },
      windowsHide: true,
      // Own process group on POSIX, so the whole tree can be signalled.
      detached: !IS_WINDOWS,
    };
    let child;
    try {
      child =
        spec.commandLine !== undefined
          ? cp.spawn(spec.commandLine, { ...options, shell: spec.shell })
          : cp.spawn(spec.file, spec.args, options);
    } catch (error) {
      this.fail(error);
      return;
    }
    run.child = child;
    run.setRunning(child.pid);

    const decoders = [child.stdout, child.stderr].filter(Boolean).map((stream) => {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (chunk) => this.output(decoder.write(chunk)));
      return decoder;
    });
    // Typing into a finished process must not raise an unhandled EPIPE.
    child.stdin?.on('error', () => undefined);
    child.on('error', (error) => this.fail(error));
    child.on('close', (code, signal) => {
      decoders.forEach((decoder) => this.output(decoder.end()));
      if (run.ended) {
        return;
      }
      // A process ended by a signal has no exit code; the terminal shows the signal instead.
      const summary = run.stopRequested ? 'Terminated' : `Exited with ${code === null ? `signal ${signal}` : `code ${code}`}`;
      this.end(`\r\n\x1b[2m${summary}\x1b[0m\r\n`, run.stopRequested ? 'terminated' : 'exited', code ?? undefined);
    });
  }

  /** Called when the terminal is closed or the task is terminated from VS Code. */
  close() {
    this.run.stopRequested = true;
    if (this.run.child) {
      killTree(this.run.child);
    }
  }

  handleInput(data) {
    if (data === '\x03') {
      this.close();
      return;
    }
    const { child } = this.run;
    if (this.run.ended || !child?.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
      return;
    }
    child.stdin.write(data.replace(/\r/g, '\n'));
    this.writeEmitter.fire(data.replace(/\r/g, '\r\n'));
  }

  output(text) {
    if (!text) {
      return;
    }
    this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
    this.run.append(text);
  }

  fail(error) {
    if (this.run.ended) {
      return;
    }
    const message = messageOf(error);
    this.log.error(`"${this.run.label}": Failed to start: ${message}`);
    this.run.fail(message);
    this.end(`\x1b[31mFailed to start: ${message}\x1b[0m\r\n`, undefined, 1);
  }

  /** Prints the last line, ends the run unless already ended, closes the terminal and frees the emitters. */
  end(lastLine, state, exitCode) {
    this.writeEmitter.fire(lastLine);
    if (state) {
      this.run.finish(state, exitCode);
    }
    this.closeEmitter.fire(exitCode ?? 1);
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

/** The shell a task without `options.shell.executable` runs in: VS Code's default terminal shell. */
function defaultShell() {
  return vscode.env.shell || true;
}

const shellKind = (shell) => (/pwsh|powershell/i.test(shell) ? 'powershell' : /cmd(\.exe)?$/i.test(shell) ? 'cmd' : 'posix');

/**
 * Quotes one argument the way VS Code's own task runner does for the shell: single quotes on POSIX
 * shells and PowerShell, double quotes on cmd. Weak quoting keeps variables expanding where the shell
 * supports that in double quotes.
 */
function quoteArgument(value, quoting, shell) {
  const kind = shellKind(typeof shell === 'string' ? shell : vscode.env.shell ?? '');
  const needsQuotes = quoting === vscode.ShellQuoting.Strong || quoting === vscode.ShellQuoting.Weak;
  if (!needsQuotes && !/[\s"'&|<>^;()$`]/.test(value)) {
    return value;
  }
  if (kind === 'cmd') {
    return `"${value.replace(/"/g, '""')}"`;
  }
  if (kind === 'powershell') {
    return quoting === vscode.ShellQuoting.Weak ? `"${value.replace(/["`$]/g, '`$&')}"` : `'${value.replace(/'/g, "''")}'`;
  }
  return quoting === vscode.ShellQuoting.Weak ? `"${value.replace(/["\\$`]/g, '\\$&')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolves the predefined variables a spawned process can know; anything else needs VS Code itself. */
function resolveVariables(value, folder) {
  const folderFor = (match, name) => {
    const found = name ? vscode.workspace.workspaceFolders?.find((candidate) => candidate.name === name) : folder;
    if (!found) {
      throw new UnresolvableVariableError(
        name ? `uses ${match}, but no workspace folder is named "${name}"` : `uses ${match} without a workspace folder`,
      );
    }
    return found;
  };
  return value.replace(/\$\{([^}:]+)(?::([^}]*))?\}/g, (match, kind, argument) => {
    switch (kind) {
      case 'workspaceFolder':
      case 'workspaceRoot':
        return folderFor(match, argument).uri.fsPath;
      case 'workspaceFolderBasename':
        return folderFor(match).name;
      case 'env':
        return process.env[argument ?? ''] ?? '';
      case 'userHome':
        return os.homedir();
      case 'pathSeparator':
      case '/':
        return path.sep;
      default:
        throw new UnresolvableVariableError(`uses ${match}, which only VS Code can resolve`);
    }
  });
}

/**
 * The tasks.json entry of a task, which holds the dependsOn and problemMatcher that fetched tasks lack.
 * User tasks, workspace-file tasks and folder tasks are searched in turn.
 */
function configuredTaskOf(task) {
  if (task.source !== 'Workspace') {
    return undefined;
  }
  const folder = typeof task.scope === 'object' ? task.scope : undefined;
  const inspected = vscode.workspace.getConfiguration('tasks', folder?.uri).inspect('tasks');
  const scopes = [inspected?.workspaceFolderValue, inspected?.workspaceValue, inspected?.globalValue];
  return scopes
    .flatMap((entries) => (Array.isArray(entries) ? entries : []))
    .find((entry) => (entry.label ?? entry.taskName) === task.name);
}

/**
 * Resolves the command a task would run, so it can be spawned with captured output.
 * @returns {{ spec?: object, reason?: string }} the spawn spec, or why only VS Code can run the task
 */
function toSpawnSpec(task, folder) {
  const execution = task.execution;
  const configured = configuredTaskOf(task);
  if (configured?.dependsOn || (task.definition && 'dependsOn' in task.definition)) {
    return { reason: 'the task has dependsOn, which only VS Code can run' };
  }
  const configuredMatchers = [configured?.problemMatcher ?? []].flat();
  if (configuredMatchers.some((matcher) => typeof matcher !== 'string')) {
    return { reason: 'the task has an inline problemMatcher, which only VS Code can apply' };
  }
  const problemMatchers = task.problemMatchers.length ? task.problemMatchers : configuredMatchers;
  try {
    const resolve = (value) => resolveVariables(value, folder);
    const options = execution?.options ?? {};
    const base = folder?.uri.fsPath ?? os.homedir();
    const cwd = options.cwd ? path.resolve(base, resolve(options.cwd)) : base;
    const env = Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, resolve(value)]));

    if (execution instanceof vscode.ShellExecution) {
      const shell = options.executable ? resolve(options.executable) : defaultShell();
      const commandLine =
        execution.commandLine !== undefined
          ? resolve(execution.commandLine)
          : [execution.command, ...(execution.args ?? [])]
              .filter((part) => part !== undefined)
              .map((part) =>
                typeof part === 'string'
                  ? quoteArgument(resolve(part), undefined, shell)
                  : quoteArgument(resolve(part.value), part.quoting, shell),
              )
              .join(' ');
      return { spec: { commandLine, shell, cwd, env, problemMatchers } };
    }
    if (execution instanceof vscode.ProcessExecution) {
      return {
        spec: { file: resolve(execution.process), args: execution.args.map(resolve), cwd, env, problemMatchers },
      };
    }
    return { reason: execution ? 'the task uses a custom execution' : 'the task has no command of its own' };
  } catch (error) {
    if (error instanceof UnresolvableVariableError) {
      return { reason: `the task ${error.message}` };
    }
    throw error;
  }
}

/** Same name, source and folder as the original, so VS Code shows the same label and terminal title. */
function toCapturedTask(task, run, spec, log) {
  const captured = new vscode.Task(
    { type: 'mcp-vscode', label: run.label, folder: run.folderName ?? '' },
    task.scope ?? vscode.TaskScope.Workspace,
    task.name,
    task.source,
    new vscode.CustomExecution(async () => new CapturedPty(run, spec, log)),
    spec.problemMatchers,
  );
  captured.isBackground = task.isBackground;
  captured.presentationOptions = { ...task.presentationOptions };
  captured.group = task.group;
  captured.detail = task.detail;
  return captured;
}

module.exports = { messageOf, killTree, toSpawnSpec, toCapturedTask };
