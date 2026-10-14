'use strict';

const vscode = require('vscode');
const { plural } = require('../shared/text');
const { relativePath } = require('../workspace/paths');

const saveProperty = {
  type: 'boolean',
  default: true,
  description: 'Save the changed files. false leaves them unsaved in the editor, undoable with Ctrl+Z.',
};

/** Applies a WorkspaceEdit as one undoable step, optionally saves the changed files, and summarizes. */
async function applyEdit(edit, save) {
  const uris = edit.entries().map(([uri]) => uri);
  if (!uris.length) {
    return 'No changes.';
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code refused the edit; a file may have changed since it was computed.');
  }
  const names = uris.map((uri) => relativePath(uri));
  if (save) {
    const saved = await Promise.all(uris.map(async (uri) => (await vscode.workspace.openTextDocument(uri)).save()));
    const unsaved = names.filter((name, index) => !saved[index]);
    if (unsaved.length) {
      throw new Error(`Changed ${plural(uris.length, 'file')}, but could not save: ${unsaved.join(', ')}.`);
    }
  }
  return `Changed ${plural(uris.length, 'file')}, ${save ? 'saved' : 'unsaved'}: ${names.join(', ')}.`;
}

/** WorkspaceEdit of TextEdits in one document. */
function documentEdit(uri, textEdits) {
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, textEdits);
  return edit;
}

module.exports = { saveProperty, applyEdit, documentEdit };
