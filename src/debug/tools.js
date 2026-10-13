'use strict';

const vscode = require('vscode');
const { nextEvent, anyEvent } = require('../shared/async');
const { plural } = require('../shared/text');
const { NO_ARGS, pathProperty, timeoutProperty } = require('../shared/schema');
const { resolveWorkspaceUri, relativePath } = require('../workspace/paths');
const { describeSession, inspectDebugger } = require('./inspect');
const { DebugState } = require('./state');

/** @typedef {import('./state').DebugState} DebugState */

const WORKSPACE_SCOPE = 'workspace';
const STOP_TIMEOUT_MS = 10000;

const CONTROL_COMMANDS = {
  continue: 'workbench.action.debug.continue',
  pause: 'workbench.action.debug.pause',
  step_over: 'workbench.action.debug.stepOver',
  step_into: 'workbench.action.debug.stepInto',
  step_out: 'workbench.action.debug.stepOut',
  restart: 'workbench.action.debug.restart',
};
const waitProperty = timeoutProperty(30, 'How long to wait for the debugger to pause (breakpoint or step) or end.');

/**
 * A thread paused (the value is `{ session, threadId }`) or a root session ended (the value is the
 * session). A child session, such as the one js-debug starts per Node process, ending is not a stop.
 */
const isStopEvent = (value) => Boolean(value.session) || !value.parentSession;

/** Launch configurations and compounds of one scope: a `[folder]`'s launch.json or the `[workspace]` file. */
function launchScope(folder, inspectKey, where) {
  const launch = vscode.workspace.getConfiguration('launch', folder?.uri);
  const valueOf = (key) => (inspectKey ? launch.inspect(key)?.[inspectKey] : launch.get(key)) ?? [];
  return { folder, where, configurations: valueOf('configurations'), compounds: valueOf('compounds') };
}

/**
 * Every place launch configurations live. A multi-root workspace has its .code-workspace file plus one
 * launch.json per folder; otherwise the single folder's merged settings are the only scope.
 */
function launchScopes() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!vscode.workspace.workspaceFile) {
    return [launchScope(folders[0], undefined, folders[0]?.name ?? WORKSPACE_SCOPE)];
  }
  return [
    launchScope(undefined, 'workspaceValue', WORKSPACE_SCOPE),
    ...folders.map((folder) => launchScope(folder, 'workspaceFolderValue', folder.name)),
  ];
}

/** Workspace folder by name, ignoring case. */
function folderNamed(name) {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  if (!folder) {
    throw new Error(`No workspace folder "${name}".`);
  }
  return folder;
}

/**
 * The `[folder, nameOrConfiguration]` pairs `vscode.debug.startDebugging` takes to start `name`. A folder's
 * launch.json is looked up by name. The API cannot look up the .code-workspace file by name, so its
 * configurations are passed whole, and its compounds start each member: a configuration of the same file,
 * or `{ name, folder }` of a folder's launch.json.
 */
function launchTargets(scope, name) {
  if (scope.folder) {
    return [[scope.folder, name]];
  }
  const configurationNamed = (member) => {
    const configuration = scope.configurations.find((entry) => entry.name === member);
    if (!configuration) {
      throw new Error(`"${name}" refers to "${member}", which the .code-workspace file does not define.`);
    }
    return configuration;
  };
  const compound = scope.compounds.find((entry) => entry.name === name);
  if (!compound) {
    return [[undefined, configurationNamed(name)]];
  }
  return compound.configurations.map((member) =>
    typeof member === 'string' ? [undefined, configurationNamed(member)] : [folderNamed(member.folder), member.name],
  );
}

/** A compound member: a configuration name, or `{ name, folder }` of a folder's launch.json. */
const memberText = (member) => (typeof member === 'string' ? member : `${member.name} [${member.folder}]`);

function listDebugConfigs() {
  const lines = launchScopes().flatMap(({ where, configurations, compounds }) => [
    ...configurations.map(({ name, type, request }) => `${name} (${type}, ${request}) [${where}]`),
    ...compounds.map(({ name, configurations: members }) => `${name} (compound: ${members.map(memberText).join(', ')}) [${where}]`),
  ]);
  return lines.length ? lines.join('\n') : 'No launch configurations. Add them to .vscode/launch.json.';
}

/** The scope that defines the configuration or compound `name`, narrowed to the scope named `where`. */
function scopeOfLaunch(name, where) {
  const scopes = launchScopes().filter((scope) => !where || scope.where.toLowerCase() === where.toLowerCase());
  if (where && !scopes.length) {
    throw new Error(`No workspace folder "${where}".`);
  }
  const matches = scopes.filter(({ configurations, compounds }) =>
    [...configurations, ...compounds].some((entry) => entry.name === name),
  );
  if (!matches.length) {
    throw new Error(`No launch configuration "${name}"${where ? ` in [${where}]` : ''}. list_debug_configs shows them.`);
  }
  if (matches.length > 1) {
    throw new Error(`"${name}" is defined in ${matches.map((scope) => `[${scope.where}]`).join(', ')}. Pass "folder" to pick one.`);
  }
  return matches[0];
}

/**
 * Waits until a thread pauses or a root session ends, then describes the state. Call it before the
 * action that causes the stop, so a stop that happens at once is not missed.
 * @param {DebugState} state
 */
async function waitForStop(state, timeoutSeconds) {
  const events = anyEvent(state.onDidStop, vscode.debug.onDidTerminateDebugSession);
  const stopped = await nextEvent(events, isStopEvent, timeoutSeconds * 1000);
  if (!stopped) {
    return `${describeSession(state)} Not paused within ${timeoutSeconds}s.`;
  }
  return stopped.session ? inspectDebugger(state, { max_variables: 0 }, stopped.session) : `Session "${stopped.name}" ended.`;
}

/** @param {DebugState} state */
async function startDebugging(state, { name, folder, no_debug, wait_for_pause, timeout_seconds }) {
  const targets = launchTargets(scopeOfLaunch(name, folder), name);
  const stop = wait_for_pause ? waitForStop(state, timeout_seconds) : undefined;
  for (const [targetFolder, target] of targets) {
    if (!(await vscode.debug.startDebugging(targetFolder, target, { noDebug: no_debug }))) {
      throw new Error(`"${target.name ?? target}" did not start. Check list_debug_configs and the Debug Console.`);
    }
  }
  return stop ?? describeSession(state);
}

/**
 * Stops every session and waits until VS Code reports none active; `stopDebugging` resolves once the
 * stop is requested, before the sessions end.
 */
async function stopDebugging() {
  if (!vscode.debug.activeDebugSession) {
    return 'No debug session was running.';
  }
  await vscode.debug.stopDebugging();
  if (vscode.debug.activeDebugSession) {
    await nextEvent(vscode.debug.onDidChangeActiveDebugSession, (session) => !session, STOP_TIMEOUT_MS);
  }
  return vscode.debug.activeDebugSession
    ? `Asked the sessions to stop; "${vscode.debug.activeDebugSession.name}" is still running after ${STOP_TIMEOUT_MS / 1000}s.`
    : 'Stopped debugging.';
}

/** @param {DebugState} state */
async function controlDebugger(state, { action, timeout_seconds }) {
  if (!vscode.debug.activeDebugSession) {
    throw new Error('No debug session is running. Start one with start_debugging.');
  }
  const stop = action === 'pause' && state.pausedThread() ? undefined : waitForStop(state, timeout_seconds);
  await vscode.commands.executeCommand(CONTROL_COMMANDS[action]);
  return stop ?? describeSession(state);
}

function describeBreakpoint(breakpoint) {
  const where =
    breakpoint instanceof vscode.SourceBreakpoint
      ? `${relativePath(breakpoint.location.uri)}:${breakpoint.location.range.start.line + 1}`
      : `function ${breakpoint.functionName}`;
  const details = [
    !breakpoint.enabled && 'disabled',
    breakpoint.condition && `if ${breakpoint.condition}`,
    breakpoint.logMessage && `logs "${breakpoint.logMessage}"`,
  ];
  return [where, ...details.filter(Boolean)].join(', ');
}

/** Breakpoints in the file at `uri`, on `line` when given; every breakpoint without a `uri`. */
function matchesLocation(breakpoint, uri, line) {
  if (!uri) {
    return true;
  }
  return (
    breakpoint instanceof vscode.SourceBreakpoint &&
    breakpoint.location.uri.toString() === uri.toString() &&
    (line === undefined || breakpoint.location.range.start.line === line - 1)
  );
}

function manageBreakpoints({ action, path, line, condition, log_message }) {
  const uri = path && resolveWorkspaceUri(path);
  if (action === 'add') {
    if (!uri || line === undefined) {
      throw new Error('"add" needs "path" and "line".');
    }
    const location = new vscode.Location(uri, new vscode.Position(line - 1, 0));
    vscode.debug.addBreakpoints([new vscode.SourceBreakpoint(location, true, condition, undefined, log_message)]);
    return `Added a breakpoint at ${relativePath(uri)}:${line}.`;
  }
  if (action === 'remove') {
    if (line !== undefined && !uri) {
      throw new Error('"line" needs "path".');
    }
    const removed = vscode.debug.breakpoints.filter((breakpoint) => matchesLocation(breakpoint, uri, line));
    vscode.debug.removeBreakpoints(removed);
    return `Removed ${plural(removed.length, 'breakpoint')}.`;
  }
  const all = vscode.debug.breakpoints.map(describeBreakpoint);
  return all.length ? all.join('\n') : 'No breakpoints.';
}

/** @param {{ push(...items: { dispose(): any }[]): any }} subscriptions where the debug state tracker is disposed */
function debugTools(subscriptions) {
  const state = new DebugState();
  subscriptions.push(state);
  return [
    {
      name: 'list_debug_configs',
      description: 'List the launch configurations and compounds of launch.json that start_debugging can run.',
      inputSchema: NO_ARGS,
      handler: listDebugConfigs,
    },
    {
      name: 'start_debugging',
      description: 'Start a launch configuration by name (as F5). With "wait_for_pause", waits for the first breakpoint and returns the stack.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Launch configuration or compound name, from list_debug_configs.' },
          folder: {
            type: 'string',
            description:
              'Where the configuration is defined, as list_debug_configs shows in brackets: a folder name, or "workspace" for the .code-workspace file. Needed only when the name is defined in several places.',
          },
          no_debug: { type: 'boolean', default: false, description: 'Run without debugging (as Ctrl+F5).' },
          wait_for_pause: { type: 'boolean', default: false, description: 'Wait until a breakpoint hits or the session ends.' },
          timeout_seconds: waitProperty,
        },
        required: ['name'],
      },
      handler: (args) => startDebugging(state, args),
    },
    {
      name: 'stop_debugging',
      description: 'Stop all debug sessions.',
      inputSchema: NO_ARGS,
      handler: stopDebugging,
    },
    {
      name: 'debug_control',
      description:
        'Continue, pause, step over/into/out or restart the debug session. Waits until it pauses again or ends, then returns the call stack.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: Object.keys(CONTROL_COMMANDS), description: 'What to do.' },
          timeout_seconds: waitProperty,
        },
        required: ['action'],
      },
      handler: (args) => controlDebugger(state, args),
    },
    {
      name: 'debug_inspect',
      description:
        'State of the debug session; when paused, the call stack and the variables of the selected frame. "expression" is evaluated in that frame, as in the Debug Console.',
      inputSchema: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Expression to evaluate, e.g. "user.id" or "items.length".' },
          max_variables: { type: 'integer', minimum: 0, maximum: 500, default: 50, description: 'Maximum variables per scope.' },
        },
      },
      handler: (args) => inspectDebugger(state, args),
    },
    {
      name: 'breakpoints',
      description: 'List, add or remove breakpoints. "add" supports a condition and a log message (logpoint).',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add', 'remove'], default: 'list', description: 'What to do.' },
          path: { ...pathProperty, description: `${pathProperty.description} For "remove", omit to remove all.` },
          line: { type: 'integer', minimum: 1, description: 'Line (1-based). For "remove", omit to remove all in "path".' },
          condition: { type: 'string', description: 'Break only when this expression is true.' },
          log_message: { type: 'string', description: 'Log this message instead of breaking; {expression} is interpolated.' },
        },
      },
      handler: manageBreakpoints,
    },
  ];
}

module.exports = { debugTools };
