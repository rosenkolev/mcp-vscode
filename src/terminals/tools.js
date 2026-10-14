'use strict';

const vscode = require('vscode');
const { pathProperty, maxLinesProperty, filterProperty } = require('../shared/schema');
const { sinceProperty, waitProperties, describeRun, waitAndReport } = require('../runs/report');

const DEFAULT_TERMINAL_NAME = 'MCP';

const terminalProperty = {
  type: 'string',
  description: 'Terminal name as shown in the VS Code terminal list.',
};
const namedTerminalProperty = { ...terminalProperty, default: DEFAULT_TERMINAL_NAME };

const POWERSHELL_SHELL_PATTERN = /pwsh|powershell/i;

/** Shell of a terminal; `state.shell` is often unset, and a terminal created without a shell path runs the default one. */
function shellOf(terminal) {
  return terminal.state?.shell ?? terminal.creationOptions?.shellPath ?? vscode.env.shell;
}

/** VS Code's PowerShell shell integration reports exit code 1 for any failure, from `$?`. */
function exitCodeNotes(run) {
  const shell = shellOf(run.terminal) ?? '';
  return run.exitCode === 1 && POWERSHELL_SHELL_PATTERN.test(shell)
    ? ['PowerShell reports every failed command as exit code 1; print $LASTEXITCODE for the real code.']
    : [];
}

function describeTerminal({ terminal, latest }) {
  const shell = terminal.shellIntegration
    ? `cwd ${terminal.shellIntegration.cwd?.fsPath ?? 'unknown'}`
    : 'no shell integration';
  return `"${terminal.name}" (${shell})${latest ? ` - last: ${describeRun(latest)}` : ''}`;
}

/** @param {import('./manager').TerminalManager} terminals */
function terminalTools(terminals) {
  return [
    {
      name: 'run_in_terminal',
      description:
        'Run a shell command in a named VS Code terminal, visible to the user. Creates the terminal in "cwd" if it does not exist; an existing one changes to "cwd" first. Waits for the command to exit by default and returns its exit code and output. The terminal closes once the command ends unless keep_open is set; its output stays readable with read_terminal. Needs shell integration (PowerShell, bash, zsh, fish); without it the command is only sent and the terminal stays open.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to run, in the syntax of the terminal shell.' },
          cwd: {
            ...pathProperty,
            description: `Directory to run in. ${pathProperty.description} Default: the current directory of the terminal.`,
          },
          terminal: namedTerminalProperty,
          keep_open: {
            type: 'boolean',
            default: false,
            description: 'Keep the terminal open after the command ends, so the user can look at its output.',
          },
          ...waitProperties(true),
          max_lines: maxLinesProperty,
        },
        required: ['command'],
      },
      handler: async (args) => {
        const { run, reason } = await terminals.run(args);
        if (!run) {
          return `Sent "${args.command}" to terminal "${args.terminal}". Output not readable: ${reason}.`;
        }
        return waitAndReport(run, args, 0, exitCodeNotes);
      },
    },
    {
      name: 'read_terminal',
      description:
        'Read the state, exit code and output of a command run in a terminal, including commands the user typed. Only commands run with shell integration since the extension started are captured. A terminal that run_in_terminal closed is still readable by its name. Without "terminal", lists the open terminals with their latest command.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: terminalProperty,
          command: {
            type: 'string',
            description: 'Case-insensitive substring of the command line; reads the latest command containing it. Default: the latest command.',
          },
          since: sinceProperty,
          filter: filterProperty,
          max_lines: maxLinesProperty,
          ...waitProperties(false),
        },
      },
      handler: async (args) => {
        if (!args.terminal) {
          return terminals.list().map(describeTerminal).join('\n') || 'No terminals are open.';
        }
        const run = terminals.find(args.terminal, args.command);
        return waitAndReport(run, args, undefined, exitCodeNotes);
      },
    },
    {
      name: 'clear_terminal',
      description: 'Clear the screen of a terminal and drop its captured finished commands.',
      inputSchema: {
        type: 'object',
        properties: { terminal: namedTerminalProperty },
      },
      handler: async ({ terminal }) => {
        await terminals.clear(terminal);
        return `Cleared terminal "${terminal}".`;
      },
    },
    {
      name: 'send_to_terminal',
      description:
        'Type text into a terminal, e.g. "y" to answer a prompt or input for a running program, or press Ctrl+C to interrupt it. Works in task terminals too. With a wait_* argument, then waits like read_terminal and returns the new output.',
      inputSchema: {
        type: 'object',
        properties: {
          terminal: namedTerminalProperty,
          text: { type: 'string', description: 'Text to type.' },
          enter: { type: 'boolean', default: true, description: 'Press Enter after the text.' },
          interrupt: { type: 'boolean', default: false, description: 'Press Ctrl+C first.' },
          max_lines: maxLinesProperty,
          ...waitProperties(false),
        },
      },
      handler: async (args) => {
        if (args.text === undefined && !args.interrupt) {
          throw new Error('Pass "text", "interrupt": true, or both.');
        }
        const run = terminals.send(args.terminal, args);
        const sent = [args.interrupt && 'Ctrl+C', args.text !== undefined && `"${args.text}"${args.enter ? ' + Enter' : ''}`];
        const summary = `Sent ${sent.filter(Boolean).join(', then ')} to terminal "${args.terminal}".`;
        if (!run) {
          return `${summary} No captured command is running there.`;
        }
        return `${summary}\n${await waitAndReport(run, { ...args, since: run.lineCount }, run.lineCount, exitCodeNotes)}`;
      },
    },
    {
      name: 'close_terminal',
      description: 'Close a terminal, which ends the command or task running in it. Its output stays readable with read_terminal.',
      inputSchema: {
        type: 'object',
        properties: { terminal: terminalProperty },
        required: ['terminal'],
      },
      handler: async ({ terminal }) => {
        const running = terminals.close(terminal);
        return `Closed terminal "${terminal}"${running ? `, ending "${running.command}"` : ''}.`;
      },
    },
  ];
}

module.exports = { terminalTools };
