'use strict';

const vscode = require('vscode');
const { limitLines, plural, singleLine } = require('../shared/text');
const { provide } = require('../shared/providers');
const { pathProperty, maxResultsProperty } = require('../shared/schema');
const { openDocument } = require('../workspace/paths');
const { positionSchema, formatPosition, documentPosition, describeLocations, emptyResultMessage } = require('./locations');

const DEFINITION_COMMANDS = {
  definition: 'vscode.executeDefinitionProvider',
  type_definition: 'vscode.executeTypeDefinitionProvider',
  implementation: 'vscode.executeImplementationProvider',
  declaration: 'vscode.executeDeclarationProvider',
};
const CALL_COMMANDS = { incoming: 'vscode.provideIncomingCalls', outgoing: 'vscode.provideOutgoingCalls' };
const MORE_HINT = 'raise "max_results"';

const kindName = (kind) => vscode.SymbolKind[kind] ?? 'Symbol';

/** Runs a location provider at the position and lists what it finds. */
async function findLocations(command, what, args) {
  const { document, position } = await documentPosition(args);
  const items = await provide(command, document.uri, position);
  if (!items.length) {
    return emptyResultMessage(what, document, position);
  }
  const lines = await describeLocations(items.slice(0, args.max_results));
  return [`${plural(items.length, what)}:`, ...limitLines(lines, args.max_results, MORE_HINT, items.length)].join('\n');
}

async function getHover(args) {
  const { document, position } = await documentPosition(args);
  const hovers = await provide('vscode.executeHoverProvider', document.uri, position);
  const text = hovers
    .flatMap((hover) => hover.contents.map((content) => (typeof content === 'string' ? content : content.value)))
    .filter(Boolean)
    .join('\n\n');
  return text || emptyResultMessage('hover information', document, position);
}

/** Indented outline of DocumentSymbols, or a flat list of SymbolInformation. */
function outline(symbols, depth = 0) {
  return symbols.flatMap((symbol) => {
    const { start, end } = symbol.range ?? symbol.location.range;
    const line = `${'  '.repeat(depth)}${symbol.name} (${kindName(symbol.kind)}) lines ${start.line + 1}-${end.line + 1}`;
    return [line, ...outline(symbol.children ?? [], depth + 1)];
  });
}

async function documentSymbols({ path }) {
  const symbols = await provide('vscode.executeDocumentSymbolProvider', (await openDocument(path)).uri);
  return symbols.length ? outline(symbols).join('\n') : `No symbols in ${path}; the language server may still be loading.`;
}

function describeSymbol({ name, kind, containerName, location }) {
  return `${name} (${kindName(kind)})${containerName ? ` in ${containerName}` : ''} - ${formatPosition(location.uri, location.range.start)}`;
}

async function workspaceSymbols({ query, max_results }) {
  const symbols = await provide('vscode.executeWorkspaceSymbolProvider', query);
  return symbols.length
    ? limitLines(symbols.map(describeSymbol), max_results, `narrow the query or ${MORE_HINT}`).join('\n')
    : `No symbols match "${query}".`;
}

function describeCallItem(item) {
  return `${item.name} (${kindName(item.kind)}) - ${formatPosition(item.uri, item.selectionRange.start)}`;
}

async function callHierarchy(args) {
  const { document, position } = await documentPosition(args);
  const [item] = await provide('vscode.prepareCallHierarchy', document.uri, position);
  if (!item) {
    return emptyResultMessage('callable symbol', document, position);
  }
  const calls = await provide(CALL_COMMANDS[args.direction], item);
  const lines = calls.map((call) => `  ${describeCallItem(call.from ?? call.to)}`);
  const heading = `${args.direction === 'incoming' ? 'Callers of' : 'Calls made by'} ${describeCallItem(item)}:`;
  return [heading, ...(lines.length ? limitLines(lines, args.max_results, MORE_HINT) : ['  none'])].join('\n');
}

const TYPE_COMMANDS = { supertypes: 'vscode.provideSupertypes', subtypes: 'vscode.provideSubtypes' };

async function typeHierarchy(args) {
  const { document, position } = await documentPosition(args);
  const [item] = await provide('vscode.prepareTypeHierarchy', document.uri, position);
  if (!item) {
    return emptyResultMessage('class or interface', document, position);
  }
  const types = await provide(TYPE_COMMANDS[args.direction], item);
  const lines = types.map((type) => `  ${describeCallItem(type)}`);
  const heading = `${args.direction === 'supertypes' ? 'Supertypes' : 'Subtypes'} of ${describeCallItem(item)}:`;
  return [heading, ...(lines.length ? limitLines(lines, args.max_results, MORE_HINT) : ['  none'])].join('\n');
}

/**
 * Position where completion or signature help is asked: after `symbol` when it is given without
 * `column`, e.g. after "user." or "fetch(".
 */
async function positionAfter(args) {
  const { document, position } = await documentPosition(args);
  return {
    document,
    position: args.column === undefined && args.symbol ? position.translate(0, args.symbol.length) : position,
  };
}

const textOf = (value) => (typeof value === 'string' ? value : value?.value ?? '');

async function signatureHelp(args) {
  const { document, position } = await positionAfter(args);
  const [help] = await provide('vscode.executeSignatureHelpProvider', document.uri, position);
  if (!help?.signatures.length) {
    return emptyResultMessage('call signature', document, position);
  }
  return help.signatures
    .flatMap((signature, index) => {
      const active = index === help.activeSignature;
      const parameter = active ? signature.parameters[signature.activeParameter ?? help.activeParameter] : undefined;
      const parameterLabel = Array.isArray(parameter?.label) ? signature.label.slice(...parameter.label) : parameter?.label;
      return [
        `${active ? '* ' : '  '}${signature.label}`,
        ...(parameterLabel ? [`    current parameter: ${parameterLabel}${parameter.documentation ? ` - ${singleLine(textOf(parameter.documentation))}` : ''}`] : []),
        ...(active && signature.documentation ? [`    ${singleLine(textOf(signature.documentation))}`] : []),
      ];
    })
    .join('\n');
}

const completionLabel = (item) => (typeof item.label === 'string' ? item.label : item.label.label);

function describeCompletion(item) {
  const detail = item.detail ?? (typeof item.label === 'string' ? undefined : item.label.detail ?? item.label.description);
  const kind = item.kind !== undefined ? ` (${vscode.CompletionItemKind[item.kind]})` : '';
  return `${completionLabel(item)}${kind}${detail ? ` - ${singleLine(detail)}` : ''}`;
}

async function completions(args) {
  const { document, position } = await positionAfter(args);
  const [list] = await provide('vscode.executeCompletionItemProvider', document.uri, position);
  const needle = args.filter?.toLowerCase();
  const items = (list?.items ?? [])
    .filter((item) => !needle || completionLabel(item).toLowerCase().includes(needle))
    .sort((a, b) => (a.sortText ?? completionLabel(a)).localeCompare(b.sortText ?? completionLabel(b)));
  if (!items.length) {
    return emptyResultMessage(needle ? `completion containing "${args.filter}"` : 'completion', document, position);
  }
  return [
    `${plural(items.length, 'completion')}:`,
    ...limitLines(items.map(describeCompletion), args.max_results, `pass "filter" or ${MORE_HINT}`),
  ].join('\n');
}

const afterSymbolColumn = {
  column: {
    type: 'integer',
    minimum: 1,
    description: 'Column (1-based) where the text would be typed. Default: right after "symbol".',
  },
  symbol: { type: 'string', description: 'Text on the line to place the cursor after, e.g. "user." or "fetch(".' },
};

function navigationTools() {
  return [
    {
      name: 'find_definition',
      description:
        'Go to the definition (or type definition, implementation, declaration) of the symbol at a position, using the language server. Returns path:line:column and the line text.',
      inputSchema: positionSchema({
        kind: { type: 'string', enum: Object.keys(DEFINITION_COMMANDS), default: 'definition', description: 'What to find.' },
        max_results: maxResultsProperty,
      }),
      handler: (args) => findLocations(DEFINITION_COMMANDS[args.kind], args.kind.replace('_', ' '), args),
    },
    {
      name: 'find_references',
      description:
        'Find all references to the symbol at a position across the workspace, using the language server (as Shift+F12). Returns path:line:column and the line text of each.',
      inputSchema: positionSchema({ max_results: maxResultsProperty }),
      handler: (args) => findLocations('vscode.executeReferenceProvider', 'reference', args),
    },
    {
      name: 'get_hover',
      description: 'Hover information of the symbol at a position: its type, signature and documentation.',
      inputSchema: positionSchema(),
      handler: getHover,
    },
    {
      name: 'document_symbols',
      description: 'Outline of a file: its classes, functions, variables and their line ranges, nested.',
      inputSchema: { type: 'object', properties: { path: pathProperty }, required: ['path'] },
      handler: documentSymbols,
    },
    {
      name: 'workspace_symbols',
      description: 'Find symbols by name across the workspace (as Ctrl+T), with their kind and location.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Symbol name or a fuzzy part of it.' }, max_results: maxResultsProperty },
        required: ['query'],
      },
      handler: workspaceSymbols,
    },
    {
      name: 'call_hierarchy',
      description: 'List the callers of the function at a position (incoming), or the functions it calls (outgoing).',
      inputSchema: positionSchema({
        direction: { type: 'string', enum: Object.keys(CALL_COMMANDS), default: 'incoming', description: 'Callers or callees.' },
        max_results: maxResultsProperty,
      }),
      handler: callHierarchy,
    },
    {
      name: 'type_hierarchy',
      description: 'List the supertypes (base classes, implemented interfaces) or subtypes of the class or interface at a position.',
      inputSchema: positionSchema({
        direction: { type: 'string', enum: Object.keys(TYPE_COMMANDS), default: 'supertypes', description: 'Supertypes or subtypes.' },
        max_results: maxResultsProperty,
      }),
      handler: typeHierarchy,
    },
    {
      name: 'signature_help',
      description:
        'Signatures of the function being called at a position, with the current parameter and its documentation (as the parameter hints while typing a call).',
      inputSchema: positionSchema(afterSymbolColumn),
      handler: signatureHelp,
    },
    {
      name: 'completions',
      description:
        'What the editor would suggest typing at a position (IntelliSense), e.g. the members of an object after "user.", with kind and type.',
      inputSchema: positionSchema({
        ...afterSymbolColumn,
        filter: { type: 'string', description: 'Case-insensitive substring of the suggestion label.' },
        max_results: maxResultsProperty,
      }),
      handler: completions,
    },
  ];
}

module.exports = { navigationTools };
