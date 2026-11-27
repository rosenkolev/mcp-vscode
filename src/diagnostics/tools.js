'use strict';

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { nextEvent } = require('../shared/async');
const { singleLine } = require('../shared/text');
const { relativePath, resolveWorkspacePath } = require('../workspace/paths');

/** Indexed by vscode.DiagnosticSeverity. */
const SEVERITIES = ['error', 'warning', 'info', 'hint'];
/** How long to wait for the language server to check a file opened for get_diagnostics. */
const FILE_CHECK_TIMEOUT_MS = 5000;

function formatDiagnostic({ file, diagnostic }) {
  const { line, character } = diagnostic.range.start;
  const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
  const origin = [diagnostic.source, code].filter((part) => part !== undefined && part !== '').join(' ');
  const severity = SEVERITIES[diagnostic.severity];
  return `${file}:${line + 1}:${character + 1} ${severity}${origin ? ` [${origin}]` : ''} ${singleLine(diagnostic.message)}`;
}

const isTabOf = (tab, key) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === key;

/**
 * When `input` is a file without diagnostics, shows it in a preview tab, keeping the focus, and waits
 * a moment for its language server: servers such as TypeScript check only files open in a tab, so a new
 * file had none yet. Returns a function that closes the tab again when it was opened here.
 */
async function checkFile(input) {
  const file = resolveWorkspacePath(input);
  if (!(await fs.stat(file).catch(() => undefined))?.isFile()) {
    return () => undefined;
  }
  const uri = vscode.Uri.file(file);
  const key = uri.toString();
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => isTabOf(tab, key));
  if (vscode.languages.getDiagnostics(uri).length || tabs().length) {
    return () => undefined;
  }
  const checked = nextEvent(vscode.languages.onDidChangeDiagnostics, ({ uris }) => uris.some((changed) => changed.toString() === key), FILE_CHECK_TIMEOUT_MS);
  await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true });
  await checked;
  return () => vscode.window.tabGroups.close(tabs().filter((tab) => !tab.isDirty));
}

async function listDiagnostics(args) {
  const close = args.path ? await checkFile(args.path) : () => undefined;
  try {
    return collectDiagnostics(args);
  } finally {
    await close();
  }
}

function collectDiagnostics({ path: pathFilter, severity, max_items }) {
  const lowest = SEVERITIES.indexOf(severity);
  const needle = pathFilter && path.normalize(pathFilter).toLowerCase();
  const matches = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (needle && !uri.fsPath.toLowerCase().includes(needle)) {
      continue;
    }
    const file = relativePath(uri);
    for (const diagnostic of diagnostics.filter((candidate) => candidate.severity <= lowest)) {
      matches.push({ file, diagnostic });
    }
  }
  if (!matches.length) {
    return `No diagnostics of severity ${severity} or higher${pathFilter ? ` in paths containing "${pathFilter}"` : ''}.`;
  }
  matches.sort((a, b) => a.diagnostic.severity - b.diagnostic.severity);
  const counts = SEVERITIES.slice(0, lowest + 1).map(
    (name, level) => `${matches.filter(({ diagnostic }) => diagnostic.severity === level).length} ${name}`,
  );
  const shown = matches.length > max_items ? `; showing the first ${max_items}` : '';
  return [`${counts.join(', ')}${shown}.`, ...matches.slice(0, max_items).map(formatDiagnostic)].join('\n');
}

function diagnosticTools() {
  return [
    {
      name: 'get_diagnostics',
      description:
        'List the errors and warnings of the Problems panel: language servers, linters and task problem matchers, errors first. Language servers usually only check files that are open or part of a running watch task; a "path" naming one file shows it briefly, so it gets checked.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Case-insensitive substring of the file path, e.g. "apps/web/src" or a file name; or the path of one file.',
          },
          severity: {
            type: 'string',
            enum: SEVERITIES,
            default: 'warning',
            description: 'Lowest severity to include.',
          },
          max_items: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Maximum diagnostics to return.' },
        },
      },
      handler: listDiagnostics,
    },
  ];
}

module.exports = { diagnosticTools };
