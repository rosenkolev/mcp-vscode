'use strict';

const vscode = require('vscode');
const { plural, rangeText } = require('../shared/text');
const { provide } = require('../shared/providers');
const { NO_ARGS, pathProperty } = require('../shared/schema');
const { openDocument, relativePath } = require('../workspace/paths');
const { saveProperty, applyEdit, documentEdit } = require('./edits');

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
  return selection.isEmpty
    ? `Cursor at ${rangeText(selection)}, nothing selected.`
    : `Selection ${rangeText(selection)}:\n${document.getText(selection).slice(0, MAX_SELECTION_CHARS)}`;
}

function getSelection() {
  const editor = vscode.window.activeTextEditor;
  return editor
    ? [relativePath(editor.document.uri), ...editor.selections.map((selection) => describeSelection(editor.document, selection))].join('\n')
    : 'No active text editor.';
}

function documentTools() {
  return [
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
