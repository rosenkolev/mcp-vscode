'use strict';

const vscode = require('vscode');
const { plural } = require('../shared/text');
const { relativePath } = require('../workspace/paths');
const { searchFiles, MAX_FILES } = require('./files');

function formatSearch({ files, matchCount, fileLimitHit }, maxResults) {
  if (!matchCount) {
    return `No matches${fileLimitHit ? ` in the first ${MAX_FILES} files; narrow with "include"` : ''}.`;
  }
  const notes = [
    matchCount >= maxResults && `Stopped at ${maxResults} matches; narrow with "include" or raise "max_results".`,
    fileLimitHit && `Only the first ${MAX_FILES} files were searched; narrow with "include".`,
  ];
  const results = files.flatMap(({ uri, lines }) => [
    relativePath(uri),
    ...lines.map(([line, text]) => `  ${line}: ${text}`),
  ]);
  return [`${plural(matchCount, 'match', 'matches')} in ${plural(files.length, 'file')}.`, ...notes.filter(Boolean), ...results].join(
    '\n',
  );
}

/** Shows the same search in the Search view, for the user to follow. */
function showInSearchView({ query, is_regex, case_sensitive, whole_word, include, exclude }) {
  return vscode.commands.executeCommand('workbench.action.findInFiles', {
    query,
    isRegex: is_regex,
    isCaseSensitive: case_sensitive,
    matchWholeWord: whole_word,
    filesToInclude: include ?? '',
    filesToExclude: exclude ?? '',
    triggerSearch: true,
  });
}

async function searchInFiles(args) {
  const result = await searchFiles(args);
  if (args.show) {
    await showInSearchView(args);
  }
  return formatSearch(result, args.max_results);
}

function searchTools() {
  return [
    {
      name: 'search_in_files',
      description:
        'Search the text of the workspace files, as the Search view (Ctrl+Shift+F) does: files.exclude and search.exclude apply, open editors count with their unsaved changes. Returns matching lines grouped by file. Files over 1 MB and binary files are skipped.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to find, or a regular expression with "is_regex".' },
          is_regex: { type: 'boolean', default: false, description: 'Treat "query" as a JavaScript regular expression.' },
          case_sensitive: { type: 'boolean', default: false, description: 'Match case.' },
          whole_word: { type: 'boolean', default: false, description: 'Match whole words only.' },
          include: {
            type: 'string',
            description:
              'Glob of the files to search, e.g. "src/**/*.ts" or "**/*.{vue,ts}". In a multi-root workspace it may start with a folder name to search that folder only.',
          },
          exclude: {
            type: 'string',
            description:
              'Glob of more files to skip, e.g. "**/*.spec.ts". In a multi-root workspace it may start with a folder name to apply to that folder only.',
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            maximum: 2000,
            default: 100,
            description: 'Maximum matching lines to return.',
          },
          show: { type: 'boolean', default: false, description: 'Also show the search in the VS Code Search view.' },
        },
        required: ['query'],
      },
      handler: searchInFiles,
    },
  ];
}

module.exports = { searchTools };
