'use strict';

const vscode = require('vscode');
const { provide } = require('../shared/providers');
const { pathProperty } = require('../shared/schema');
const { saveProperty, applyEdit } = require('../documents/edits');
const { openDocument } = require('../workspace/paths');
const { lineProperty, positionSchema, checkLine, documentPosition } = require('./locations');

async function renameSymbol(args) {
  const { document, position } = await documentPosition(args);
  const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', document.uri, position, args.new_name);
  if (!edit) {
    throw new Error('Nothing to rename at this position.');
  }
  return applyEdit(edit, args.save);
}

/** Whole lines from `line` to `end_line`; a code action provider needs a range, not a position. */
function lineRange(document, { line, end_line }) {
  checkLine(document, line);
  if (end_line !== undefined && end_line < line) {
    throw new Error(`"end_line" (${end_line}) is before "line" (${line}).`);
  }
  const last = Math.min(end_line ?? line, document.lineCount);
  return new vscode.Range(line - 1, 0, last - 1, document.lineAt(last - 1).text.length);
}

/** A provider returns CodeActions, or plain Commands whose `command` is the command id. */
const isPlainCommand = (action) => typeof action.command === 'string';

function describeAction(action, index) {
  const kind = action.kind?.value ? ` [${action.kind.value}]` : '';
  return `${index + 1}. ${action.title}${kind}${action.isPreferred ? ' (preferred)' : ''}${action.disabled ? ` (disabled: ${action.disabled.reason})` : ''}`;
}

async function applyAction(action, save) {
  if (action.disabled) {
    throw new Error(`"${action.title}" is disabled: ${action.disabled.reason}`);
  }
  const command = isPlainCommand(action) ? action : action.command;
  if (!action.edit && !command) {
    throw new Error(`"${action.title}" has neither an edit nor a command to run.`);
  }
  const summary = action.edit ? await applyEdit(action.edit, save) : '';
  if (command) {
    await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
  }
  return `Applied "${action.title}". ${summary}`.trim();
}

async function codeActions(args) {
  const document = await openDocument(args.path);
  // Providers may compute an action's edit lazily; the resolve count makes VS Code resolve the first N.
  const resolveCount = args.apply ?? 0;
  const actions = await provide('vscode.executeCodeActionProvider', document.uri, lineRange(document, args), args.kind, resolveCount);
  if (args.apply === undefined) {
    return actions.length
      ? [...actions.map(describeAction), 'Apply one with "apply": <number>.'].join('\n')
      : 'No code actions for these lines.';
  }
  const action = actions[args.apply - 1];
  if (!action) {
    throw new Error(`No code action ${args.apply}; there are ${actions.length}. List them without "apply".`);
  }
  return applyAction(action, args.save);
}

function refactorTools() {
  return [
    {
      name: 'rename_symbol',
      description:
        'Rename the symbol at a position everywhere it is used, with the language server (as F2). Safer than search and replace: only real references change.',
      inputSchema: positionSchema(
        { new_name: { type: 'string', description: 'New name of the symbol.' }, save: saveProperty },
        ['new_name'],
      ),
      handler: renameSymbol,
    },
    {
      name: 'code_actions',
      description:
        'List the quick fixes and refactorings for lines of a file (as Ctrl+.), e.g. fixes for get_diagnostics errors, add import, extract function. Call again with "apply": <number> to apply one.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProperty,
          line: lineProperty,
          end_line: { type: 'integer', minimum: 1, description: 'Last line of the range (1-based). Default: "line".' },
          kind: {
            type: 'string',
            description: 'Only actions of this kind, e.g. "quickfix", "refactor", "source.organizeImports", "source.fixAll".',
          },
          apply: { type: 'integer', minimum: 1, description: 'Number of the action to apply, from the list.' },
          save: saveProperty,
        },
        required: ['path', 'line'],
      },
      handler: codeActions,
    },
  ];
}

module.exports = { refactorTools };
