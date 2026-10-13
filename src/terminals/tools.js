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
        'Run a shell command in a named VS Code terminal, visible to the user. Creates the terminal in "cwd" if it does not exist; an existing one changes to "cwd" first. Waits for the command to exit by default and returns its exit code and output. Needs shell integration (PowerShell, bash, zsh, fish); without it the command is only sent.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to run, in the syntax of the terminal shell.' },
          cwd: {
            ...pathProperty,
            description: `Directory to run in. ${pathProperty.description} Default: the current directory of the terminal.`,
          },
          terminal: namedTerminalProperty,
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
        'Read the state, exit code and output of a command run in a terminal, including commands the user typed. Only commands run with shell integration since the extension started are captured. Without "terminal", lists the open terminals with their latest command.',
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
        return waitAndReport(run, args, args.since ?? run.lineCount, exitCodeNotes);
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
  ];
}

module.exports = { terminalTools };
