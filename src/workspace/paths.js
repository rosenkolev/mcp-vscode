'use strict';

const vscode = require('vscode');
const os = require('os');
const path = require('path');

/**
 * Resolves a path given by a tool caller. Relative paths may start with a workspace folder name, or be
 * one, as `vscode.workspace.asRelativePath` prints them in a multi-root workspace; otherwise they resolve
 * against the first workspace folder.
 */
function resolveWorkspacePath(input) {
  if (path.isAbsolute(input)) {
    return path.normalize(input);
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  const [first, ...rest] = input.split(/[/\x5c]/);
  const named = folders.find((folder) => folder.name === first);
  if (named) {
    return path.join(named.uri.fsPath, ...rest);
  }
  return path.resolve(folders[0]?.uri.fsPath ?? os.homedir(), input);
}

/** Path as tools print it: relative to the workspace, prefixed with the folder name in a multi-root workspace. */
function relativePath(uriOrPath) {
  return vscode.workspace.asRelativePath(uriOrPath);
}

function resolveWorkspaceUri(input) {
  return vscode.Uri.file(resolveWorkspacePath(input));
}

/** URI of an existing file or folder; throws an error naming the missing path. */
async function existingUri(input) {
  const uri = resolveWorkspaceUri(input);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    throw new Error(`No file at ${uri.fsPath}.`);
  }
  return uri;
}

/** Text document of a path, loaded without showing it; an open document includes its unsaved changes. */
async function openDocument(input) {
  return vscode.workspace.openTextDocument(await existingUri(input));
}

/** The already open text document of a URI, with its unsaved changes; undefined when none is open. */
function openDocumentOf(uri) {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === key);
}

module.exports = { resolveWorkspacePath, resolveWorkspaceUri, relativePath, existingUri, openDocument, openDocumentOf };
