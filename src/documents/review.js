'use strict';

const vscode = require('vscode');
const { plural } = require('../shared/text');
const { openDocument, relativePath } = require('../workspace/paths');
const { toReplacements, applyReplacements } = require('./replacements');

const ORIGINAL_SCHEME = 'mcp-vscode-original';
const MAX_SNAPSHOTS = 20;

const eolOf = (document) => (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

/**
 * Edits files by exact text replacement, as one undoable step. With `review`, the edit opens in VS Code's
 * Refactor Preview, where the user applies or discards it. Keeps a snapshot of the text before each edit
 * to show the change in a diff editor.
 */
class FileEditor {
  constructor() {
    /** Text before an edit, per snapshot id. @type {Map<string, string>} */
    this.snapshots = new Map();
    this.nextSnapshot = 1;
    this.registration = vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, {
      provideTextDocumentContent: (uri) => this.snapshots.get(uri.query) ?? '',
    });
  }

  snapshotUri(document, text) {
    const id = String(this.nextSnapshot++);
    this.snapshots.set(id, text);
    [...this.snapshots.keys()].slice(0, Math.max(this.snapshots.size - MAX_SNAPSHOTS, 0)).forEach((key) => this.snapshots.delete(key));
    return document.uri.with({ scheme: ORIGINAL_SCHEME, query: id });
  }

  async edit({ path, edits, review, save, show_diff }) {
    const document = await openDocument(path);
    const name = relativePath(document.uri);
    const original = document.getText();
    const version = document.version;
    const replacements = toReplacements(original, edits, eolOf(document));
    const expected = applyReplacements(original, replacements);
    if (expected === original) {
      return `No changes: the edits leave ${name} as it is.`;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const { index, start, end, newText } of replacements) {
      const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
      const metadata = review ? { needsConfirmation: true, label: `Edit ${index + 1}`, description: name } : undefined;
      edit.replace(document.uri, range, newText, metadata);
    }

    const applied = await vscode.workspace.applyEdit(edit, review ? { isRefactoring: true } : undefined);
    const after = document.getText();
    if (!applied || after === original) {
      if (review) {
        return `The user discarded the edit to ${name} in the Refactor Preview. The file is unchanged.`;
      }
      throw new Error('VS Code refused the edit; the file may have changed. Read it again and retry.');
    }
    const outcome = describeOutcome({ review, after, expected, replacements, changedMeanwhile: document.version > version + 1 });
    if (save && !(await document.save())) {
      throw new Error(`${outcome} Saving ${name} failed.`);
    }
    if (show_diff) {
      await vscode.commands.executeCommand(
        'vscode.diff',
        this.snapshotUri(document, original),
        document.uri,
        `${name} (before MCP edit) ↔ (after)`,
        { preview: true, preserveFocus: true },
      );
    }
    return `${outcome} ${name} is ${save ? 'saved' : 'unsaved (undo with Ctrl+Z)'}.${show_diff ? ' The diff is open in the editor.' : ''}`;
  }

  dispose() {
    this.registration.dispose();
    this.snapshots.clear();
  }
}

/** What happened to the edit, from the text after it. A review may apply only some edits, or run while the user types. */
function describeOutcome({ review, after, expected, replacements, changedMeanwhile }) {
  if (after === expected) {
    return `Applied ${plural(replacements.length, 'edit')}${review ? ', approved by the user' : ''}.`;
  }
  return changedMeanwhile
    ? 'The file changed while the edit was pending, so the result may differ from the edit; read the file to check.'
    : 'The user applied only some of the edits in the Refactor Preview; read the file to see which.';
}

module.exports = { FileEditor };
