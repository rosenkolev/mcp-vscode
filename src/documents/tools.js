'use strict';

const vscode = require('vscode');
const { plural, rangeText } = require('../shared/text');
const { provide } = require('../shared/providers');
const { NO_ARGS, pathProperty } = require('../shared/schema');
const { openDocument, relativePath } = require('../workspace/paths');
const { saveProperty, applyEdit, documentEdit } = require('./edits');
const { FileEditor } = require('./review');

const MAX_SELECTION_CHARS = 20000;

async function formatDocument({ path, save }) {
  const document = await openDocument(path);
  const editor = vscode.workspace.getConfiguration('editor', document);
  const options = { tabSize: editor.get('tabSize'), insertSpaces: editor.get('insertSpaces') };
  const textEdits = await provide('vscode.executeFormatDocumentProvider', document.uri, options);
  return textEdits.length
    ? applyEdit(documentEdit(document.uri, textEdits), save)
    : `Nothing to change: ${path} is formatted, or no formatter handles ${document.languageId}.`;
}

async function saveFile(path) {
  const document = await openDocument(path);
  if (!(await document.save()) && document.isDirty) {
    throw new Error(`${path} could not be saved.`);
  }
  return `Saved ${relativePath(document.uri)}.`;
}

async function saveAll() {
  const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty).map((document) => relativePath(document.uri));
  if (!(await vscode.workspace.saveAll(false))) {
    throw new Error('Some files could not be saved.');
  }
  return dirty.length ? `Saved ${plural(dirty.length, 'file')}: ${dirty.join(', ')}.` : 'No unsaved files.';
}

function describeSelection(document, selection) {
  if (selection.isEmpty) {
    return `Cursor at ${rangeText(selection)}, nothing selected.`;
  }
  const text = document.getText(selection);
  const cut = text.length > MAX_SELECTION_CHARS ? `\n[cut to ${MAX_SELECTION_CHARS} of ${text.length} characters]` : '';
  return `Selection ${rangeText(selection)}:\n${text.slice(0, MAX_SELECTION_CHARS)}${cut}`;
}

function getSelection() {
  const editor = vscode.window.activeTextEditor;
  return editor
    ? [relativePath(editor.document.uri), ...editor.selections.map((selection) => describeSelection(editor.document, selection))].join('\n')
    : 'No active text editor.';
}

/** @param {{ push(...items: { dispose(): any }[]): any }} subscriptions where the file editor is disposed */
function documentTools(subscriptions) {
  const editor = new FileEditor();
  subscriptions.push(editor);
  return [
    {
      name: 'edit_file',
      description:
        'Replace exact text in a file, through the editor: unsaved changes are kept and the change is one Ctrl+Z step. Each "old_text" must occur once in the file. "review": true lists the edits unchecked in the Refactor Preview and waits for the user to tick the ones to keep and click Apply, or Discard; "show_diff" opens a diff of the result.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProperty,
          edits: {
            type: 'array',
            description: 'Replacements, applied together.',
            items: {
              type: 'object',
              properties: {
                old_text: { type: 'string', description: 'Exact text to replace, unique in the file.' },
                new_text: { type: 'string', description: 'Replacement text; empty to delete.' },
              },
              required: ['old_text', 'new_text'],
            },
          },
          review: {
            type: 'boolean',
            default: false,
            description: 'Let the user review the edits in the Refactor Preview, tick the ones to keep and apply or discard them. The call waits for the decision.',
          },
          show_diff: { type: 'boolean', default: false, description: 'Open a diff of the file before and after the edit.' },
          save: saveProperty,
        },
        required: ['path', 'edits'],
      },
      handler: (args) => editor.edit(args),
    },
    {
      name: 'format_document',
      description: "Format a file with the formatter VS Code uses for its language (Prettier, the language's own, ...), without opening it.",
      inputSchema: { type: 'object', properties: { path: pathProperty, save: saveProperty }, required: ['path'] },
      handler: formatDocument,
    },
    {
      name: 'save_files',
      description: 'Save one file, or every file with unsaved changes.',
      inputSchema: { type: 'object', properties: { path: { ...pathProperty, description: 'File to save. Default: all unsaved files.' } } },
      handler: ({ path }) => (path ? saveFile(path) : saveAll()),
    },
    {
      name: 'get_selection',
      description: "The active editor's file, cursor and selected text, e.g. to act on what the user selected.",
      inputSchema: NO_ARGS,
      handler: getSelection,
    },
  ];
}

module.exports = { documentTools };
