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

    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream?.on('data', (chunk) => this.output(decoder.write(chunk)));
    }
    child.on('error', (error) => this.fail(error));
    child.on('close', (code) => {
      if (run.ended) {
        return;
      }
      const summary = run.stopRequested ? 'Terminated' : `Exited with code ${code ?? 1}`;
      this.writeEmitter.fire(`\r\n\x1b[2m${summary}\x1b[0m\r\n`);
      run.finish(run.stopRequested ? 'terminated' : 'exited', code ?? undefined);
      this.closeEmitter.fire(code ?? 1);
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
    this.run.child?.stdin?.write(data.replace(/\r/g, '\n'));
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
    const message = `Failed to start: ${messageOf(error)}`;
    this.log.error(`"${this.run.label}": ${message}`);
    this.writeEmitter.fire(`\x1b[31m${message}\x1b[0m\r\n`);
    this.run.append(`${message}\n`);
    this.run.finish('failed');
    this.closeEmitter.fire(1);
  }
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

function quoteArgument(value, quoting) {
  const needsQuotes = quoting === vscode.ShellQuoting.Strong || quoting === vscode.ShellQuoting.Weak;
  if (!needsQuotes && !/[\s"&|<>^;()]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\x5c"')}"`;
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
      const commandLine =
        execution.commandLine !== undefined
          ? resolve(execution.commandLine)
          : [execution.command, ...(execution.args ?? [])]
              .filter((part) => part !== undefined)
              .map((part) =>
                typeof part === 'string'
                  ? quoteArgument(resolve(part), undefined)
                  : quoteArgument(resolve(part.value), part.quoting),
              )
              .join(' ');
      const shell = options.executable ? resolve(options.executable) : true;
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
