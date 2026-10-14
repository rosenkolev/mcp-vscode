'use strict';

const vscode = require('vscode');
const { pathProperty } = require('../shared/schema');
const { positionText, linePreview } = require('../shared/text');
const { openDocument, openDocumentOf, relativePath } = require('../workspace/paths');

const decoder = new TextDecoder();

const lineProperty = { type: 'integer', minimum: 1, description: 'Line (1-based).' };

/** Input schema of a tool that points at a position in a file, plus its own properties and required keys. */
const positionSchema = (extra = {}, required = []) => ({
  type: 'object',
  properties: {
    path: pathProperty,
    line: lineProperty,
    column: { type: 'integer', minimum: 1, description: 'Column (1-based). Default: where "symbol" starts on the line.' },
    symbol: { type: 'string', description: 'Name on the line to point at instead of "column", e.g. "useAuth".' },
    ...extra,
  },
  required: ['path', 'line', ...required],
});

function formatPosition(uri, position) {
  return `${relativePath(uri)}:${positionText(position)}`;
}

function checkLine(document, line) {
  if (line > document.lineCount) {
    throw new Error(`Line ${line} is past the end of ${relativePath(document.uri)} (${document.lineCount} lines).`);
  }
}

/** Position from the 1-based `line` and `column`; without `column`, where `symbol` first occurs on the line. */
function positionIn(document, { line, column, symbol }) {
  checkLine(document, line);
  if (column !== undefined) {
    return new vscode.Position(line - 1, column - 1);
  }
  const text = document.lineAt(line - 1).text;
  const index = symbol ? text.indexOf(symbol) : -1;
  if (index < 0) {
    throw new Error(symbol ? `"${symbol}" is not on line ${line}: ${text.trim()}` : 'Pass "column" or "symbol".');
  }
  return new vscode.Position(line - 1, index);
}

/** Document and position of a tool's position arguments. */
async function documentPosition(args) {
  const document = await openDocument(args.path);
  return { document, position: positionIn(document, args) };
}

/** `{ uri, range }` of a Location or a LocationLink. */
function toLocation(item) {
  return item.targetUri ? { uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange } : item;
}

/**
 * Lines of a file: the open document's, else read from disk. Opening a document instead would load it
 * into every language server, which is slow for long result lists.
 */
async function fileLines(uri) {
  const document = openDocumentOf(uri);
  if (document) {
    return document.getText().split(/\r?\n/);
  }
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
  } catch {
    return [];
  }
}

/** "path:line:column  text of that line" for each Location or LocationLink, reading each file once. */
async function describeLocations(items) {
  const locations = items.map(toLocation);
  const uris = [...new Map(locations.map(({ uri }) => [uri.toString(), uri])).values()];
  const linesByUri = new Map(await Promise.all(uris.map(async (uri) => [uri.toString(), await fileLines(uri)])));
  return locations.map(({ uri, range }) => {
    const text = linesByUri.get(uri.toString())[range.start.line] ?? '';
    return `${formatPosition(uri, range.start)}  ${linePreview(text)}`;
  });
}

function emptyResultMessage(what, document, position) {
  return `No ${what} at ${formatPosition(document.uri, position)}. If the file was just opened, the language server may still be loading; retry shortly.`;
}

module.exports = {
  lineProperty,
  positionSchema,
  checkLine,
  formatPosition,
  documentPosition,
  describeLocations,
  emptyResultMessage,
};
