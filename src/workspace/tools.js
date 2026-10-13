'use strict';

const vscode = require('vscode');
const { resolveWorkspaceUri, relativePath, existingUri, openDocumentOf } = require('./paths');
const { plural, positionText, rangeText } = require('../shared/text');
const { NO_ARGS, pathProperty } = require('../shared/schema');

const TAB_KINDS = [
  [vscode.TabInputText, 'text'],
  [vscode.TabInputTextDiff, 'diff'],
  [vscode.TabInputNotebook, 'notebook'],
  [vscode.TabInputNotebookDiff, 'notebook diff'],
  [vscode.TabInputCustom, 'custom editor'],
  [vscode.TabInputWebview, 'webview'],
  [vscode.TabInputTerminal, 'terminal'],
];

/** The file a tab shows; a diff tab counts as its modified side. */
function tabUri(tab) {
  return tab.input?.uri ?? tab.input?.modified;
}

function describeWorkspace() {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const file = vscode.workspace.workspaceFile;
  const kind = file
    ? `multi-root workspace${file.scheme === 'file' ? ` (${file.fsPath})` : ' (unsaved)'}`
    : folders.length
      ? 'single folder'
      : 'no folder open';
  const lines = [
    `Workspace: ${vscode.workspace.name ?? 'none'} - ${kind}`,
    `Trusted: ${vscode.workspace.isTrusted ? 'yes' : 'no (restricted mode)'}`,
  ];
  if (vscode.env.remoteName) {
    lines.push(`Remote: ${vscode.env.remoteName}`);
  }
  lines.push(`Folders (${folders.length}):`, ...folders.map((folder) => `  ${folder.name} - ${folder.uri.fsPath}`));
  return lines.join('\n');
}

function describeTab(tab) {
  const uri = tabUri(tab);
  const kind = TAB_KINDS.find(([type]) => tab.input instanceof type)?.[1] ?? 'other';
  const flags = [kind !== 'text' && kind, tab.isDirty && 'unsaved', tab.isPinned && 'pinned', tab.isPreview && 'preview'];
  const flagText = flags.filter(Boolean).join(', ');
  return `${tab.isActive ? '* ' : '  '}${uri ? relativePath(uri) : tab.label}${flagText ? ` (${flagText})` : ''}`;
}

function describeActiveEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'Active editor: none';
  }
  const { selection } = editor;
  const selected = selection.isEmpty ? '' : `, selection ${rangeText(selection)}`;
  return `Active editor: ${relativePath(editor.document.uri)}:${positionText(selection.active)}${selected}`;
}

function listTabs() {
  const groups = vscode.window.tabGroups.all.map((group, index) => [
    `Group ${index + 1}${group.isActive ? ' (active)' : ''}:`,
    ...(group.tabs.length ? group.tabs.map(describeTab) : ['  (empty)']),
  ]);
  return [describeActiveEditor(), ...groups.flat()].join('\n');
}

async function openFile({ path: input, line, column, preview, focus }) {
  const uri = await existingUri(input);
  if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
    throw new Error(`${relativePath(uri)} is a folder; open_file opens files.`);
  }
  const position = line !== undefined ? new vscode.Position(line - 1, (column ?? 1) - 1) : undefined;
  const selection = position && new vscode.Range(position, position);
  await vscode.commands.executeCommand('vscode.open', uri, { preview, preserveFocus: !focus, selection });
  return `Opened ${relativePath(uri)}${line !== undefined ? ` at line ${line}` : ''}.`;
}

/** Closes every tab of the file; tabs with unsaved changes are kept unless `save` is set. */
async function closeFile({ path: input, save }) {
  const uri = resolveWorkspaceUri(input);
  const target = uri.toString();
  const tabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tabUri(tab)?.toString() === target);
  if (!tabs.length) {
    throw new Error(`No open tab shows ${input}. Use list_tabs to see the open tabs.`);
  }
  const unsaved = tabs.filter((tab) => tab.isDirty);
  if (unsaved.length && !save) {
    throw new Error(`${input} has unsaved changes. Pass save: true to save and close it.`);
  }
  if (unsaved.length) {
    if (!(await openDocumentOf(uri)?.save())) {
      throw new Error(`${input} could not be saved, so it stays open.`);
    }
  }
  await vscode.window.tabGroups.close(tabs);
  return `Closed ${plural(tabs.length, 'tab')} of ${input}${unsaved.length ? ' after saving' : ''}.`;
}

function workspaceTools() {
  return [
    {
      name: 'get_workspace',
      description:
        'Describe the open workspace: single folder, multi-root workspace (with its .code-workspace file) or none, every workspace folder with its path, trust and remote state.',
      inputSchema: NO_ARGS,
      handler: describeWorkspace,
    },
    {
      name: 'list_tabs',
      description:
        'List the open editor tabs per editor group, marking the active ones (*), unsaved, pinned and preview tabs, plus the cursor and selection of the active editor.',
      inputSchema: NO_ARGS,
      handler: listTabs,
    },
    {
      name: 'open_file',
      description: 'Open a file in a VS Code editor tab, optionally at a line.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProperty,
          line: { type: 'integer', minimum: 1, description: 'Line to reveal and put the cursor on (1-based).' },
          column: { type: 'integer', minimum: 1, description: 'Column of the cursor (1-based); needs "line".' },
          preview: { type: 'boolean', default: false, description: 'Open as a preview tab, replaced by the next preview.' },
          focus: { type: 'boolean', default: false, description: 'Move keyboard focus to the editor.' },
        },
        required: ['path'],
      },
      handler: openFile,
    },
    {
      name: 'close_tab',
      description: 'Close every open tab of a file. A tab with unsaved changes is kept unless "save" is set.',
      inputSchema: {
        type: 'object',
        properties: {
          path: pathProperty,
          save: { type: 'boolean', default: false, description: 'Save unsaved changes, then close.' },
        },
        required: ['path'],
      },
      handler: closeFile,
    },
  ];
}

module.exports = { workspaceTools };
