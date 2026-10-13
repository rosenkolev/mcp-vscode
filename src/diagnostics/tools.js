'use strict';

const vscode = require('vscode');
const path = require('path');
const { singleLine } = require('../shared/text');
const { relativePath } = require('../workspace/paths');

/** Indexed by vscode.DiagnosticSeverity. */
const SEVERITIES = ['error', 'warning', 'info', 'hint'];

function formatDiagnostic({ file, diagnostic }) {
  const { line, character } = diagnostic.range.start;
  const code = typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code;
  const origin = [diagnostic.source, code].filter((part) => part !== undefined && part !== '').join(' ');
  const severity = SEVERITIES[diagnostic.severity];
  return `${file}:${line + 1}:${character + 1} ${severity}${origin ? ` [${origin}]` : ''} ${singleLine(diagnostic.message)}`;
}

function listDiagnostics({ path: pathFilter, severity, max_items }) {
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
        'List the errors and warnings of the Problems panel: language servers, linters and task problem matchers, errors first. Language servers usually only check files that are open or part of a running watch task.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Case-insensitive substring of the file path, e.g. "apps/web/src" or a file name.',
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
