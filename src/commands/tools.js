'use strict';

const vscode = require('vscode');
const { withTimeout } = require('../shared/async');
const { limitLines, manifestText } = require('../shared/text');
const { pathProperty, timeoutProperty } = require('../shared/schema');
const { existingUri } = require('../workspace/paths');

/** Commands that end this extension host, so they run only after the reply is sent. */
const WINDOW_ENDING_COMMANDS = [
  'workbench.action.reloadWindow',
  'workbench.action.restartExtensionHost',
  'workbench.action.closeWindow',
  'workbench.action.quit',
];
const WINDOW_ENDING_DELAY_MS = 200;
const MAX_LISTED_COMMANDS = 300;
const MAX_RESULT_CHARS = 4000;

/** "Category: Title" by command id, for commands that extensions contribute. Core commands have no readable title. */
function contributedTitles() {
  const entries = vscode.extensions.all
    .flatMap((extension) => [extension.packageJSON.contributes?.commands ?? []].flat())
    .filter(({ title }) => manifestText(title))
    .map(({ command, title, category }) => [command, [manifestText(category), title].filter(Boolean).join(': ')]);
  return new Map(entries);
}

async function listCommands({ filter }) {
  const needle = filter?.toLowerCase();
  const titles = contributedTitles();
  const lines = (await vscode.commands.getCommands(true))
    .map((id) => (titles.has(id) ? `${id} - ${titles.get(id)}` : id))
    .filter((line) => !needle || line.toLowerCase().includes(needle))
    .sort();
  return lines.length ? limitLines(lines, MAX_LISTED_COMMANDS, 'narrow with "filter"').join('\n') : 'No matching commands.';
}

/** JSON of a command result, with URIs as paths and long results truncated; empty when there is none. */
function formatResult(value) {
  if (value === undefined || value === null) {
    return '';
  }
  let text;
  try {
    // `this[key]` is the value before toJSON, so a Uri is still recognizable.
    text = JSON.stringify(value, function replacer(key, item) {
      return this[key] instanceof vscode.Uri ? this[key].fsPath : item;
    }, 2);
  } catch {
    text = String(value);
  }
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated` : text;
}

async function runCommand({ command, args, file, timeout_seconds }) {
  if (file) {
    await vscode.window.showTextDocument(await existingUri(file), { preview: false });
  }
  if (WINDOW_ENDING_COMMANDS.includes(command)) {
    setTimeout(() => vscode.commands.executeCommand(command, ...args), WINDOW_ENDING_DELAY_MS);
    return `Scheduled ${command}. It ends this window's extension host, so the MCP connection drops until VS Code is back.`;
  }
  const { done, value } = await withTimeout(vscode.commands.executeCommand(command, ...args), timeout_seconds * 1000);
  if (!done) {
    return `${command} is still running after ${timeout_seconds}s; it may be waiting for input in the VS Code window.`;
  }
  const result = formatResult(value);
  return result ? `Ran ${command}. Result:\n${result}` : `Ran ${command}.`;
}

function commandTools() {
  return [
    {
      name: 'list_commands',
      description:
        'List the ids of the VS Code commands available in this window, with the title of commands that extensions contribute. Use it to find an id for run_command.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Case-insensitive substring of the command id or title, e.g. "format" or "git.".' },
        },
      },
      handler: listCommands,
    },
    {
      name: 'run_command',
      description:
        'Run a VS Code command by id, as from the Command Palette (Ctrl+Shift+P): e.g. "editor.action.formatDocument" with "file", "workbench.action.files.saveAll" or "workbench.action.reloadWindow". Returns the command result as JSON. Commands act with the user\'s rights: run only what the user asked for or the task needs.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command id, e.g. "editor.action.formatDocument". list_commands finds ids.' },
          args: { type: 'array', items: {}, default: [], description: 'Arguments passed to the command, as JSON values.' },
          file: { ...pathProperty, description: `File to open and focus first, for editor commands. ${pathProperty.description}` },
          timeout_seconds: timeoutProperty(30, 'A command that waits for user input keeps waiting after it.'),
        },
        required: ['command'],
      },
      handler: runCommand,
    },
  ];
}

module.exports = { commandTools };
