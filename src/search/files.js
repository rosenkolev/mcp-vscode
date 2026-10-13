'use strict';

const vscode = require('vscode');
const { linePreview } = require('../shared/text');

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8000;
const READ_BATCH_SIZE = 32;
const EXCLUDE_SETTINGS = ['files.exclude', 'search.exclude'];
const ALL_FILES = '**/*';
const decoder = new TextDecoder();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\x5c]/g, '\x5c$&');
}

/**
 * Regex of the query, multiline so that `^` and `$` hold at every line end: it tests a whole file, then
 * each line of a file that matches. Throws a readable error for an invalid regex.
 */
function toLinePattern({ query, is_regex, case_sensitive, whole_word }) {
  const source = is_regex ? query : escapeRegExp(query);
  try {
    return new RegExp(whole_word ? String.raw`\b(?:${source})\b` : source, case_sensitive ? 'm' : 'im');
  } catch (error) {
    throw new Error(`"query" is not a valid regular expression: ${error.message}`);
  }
}

/**
 * One glob of the enabled files.exclude and search.exclude patterns plus the caller's own, as the Search
 * view applies them. Conditional (`when`) patterns are left out.
 */
function excludeGlob(extra) {
  const configuration = vscode.workspace.getConfiguration();
  const patterns = EXCLUDE_SETTINGS.flatMap((setting) =>
    Object.entries(configuration.get(setting) ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([glob]) => glob),
  );
  const all = extra ? [...patterns, extra] : patterns;
  return all.length ? `{${all.join(',')}}` : undefined;
}

/** Marks a glob that names another workspace folder, so it does not apply to the folder at hand. */
const OTHER_FOLDER = Symbol('other folder');

/**
 * A caller's glob as it applies inside `folder`. A glob that is or starts with a workspace folder name,
 * as tools print paths, applies to that folder alone, with the name removed; any other glob applies to
 * every folder unchanged.
 */
function globInFolder(glob, folder) {
  if (!glob) {
    return undefined;
  }
  const [first, ...rest] = glob.split(/[/\x5c]/);
  if (!vscode.workspace.workspaceFolders?.some((candidate) => candidate.name === first)) {
    return glob;
  }
  return first === folder.name ? rest.filter(Boolean).join('/') || '**' : OTHER_FOLDER;
}

/**
 * Workspace files the search covers, in path order, at most MAX_FILES. Searched folder by folder, so a
 * folder-name prefix in `include` or `exclude` narrows to that folder.
 */
async function findWorkspaceFiles(include, exclude) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return vscode.workspace.findFiles(include ?? ALL_FILES, excludeGlob(exclude), MAX_FILES);
  }
  const perFolder = await Promise.all(
    folders.map((folder) => {
      const included = globInFolder(include, folder) ?? ALL_FILES;
      const excluded = globInFolder(exclude, folder);
      if (included === OTHER_FOLDER) {
        return [];
      }
      const extraExclude = excluded === OTHER_FOLDER ? undefined : excluded;
      return vscode.workspace.findFiles(new vscode.RelativePattern(folder, included), excludeGlob(extraExclude), MAX_FILES);
    }),
  );
  return perFolder.flat();
}

/** Text of a file: the open document's, which has unsaved changes, else the file's; undefined for big or binary files. */
async function readText(uri, openDocuments) {
  const document = openDocuments.get(uri.toString());
  if (document) {
    return document.getText();
  }
  if ((await vscode.workspace.fs.stat(uri)).size > MAX_FILE_BYTES) {
    return undefined;
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) ? undefined : decoder.decode(bytes);
}

/** `[lineNumber, text]` of every line that matches, 1-based. Most files have no match, so one test on the whole text skips them. */
function matchingLines(text, pattern) {
  if (!pattern.test(text)) {
    return [];
  }
  return text
    .split(/\r?\n/)
    .flatMap((line, index) => (pattern.test(line) ? [[index + 1, linePreview(line)]] : []));
}

/**
 * Searches the workspace files line by line, in path order, until `max_results` matching lines are found.
 * @returns {Promise<{ files: { uri: vscode.Uri, lines: [number, string][] }[], matchCount: number, fileLimitHit: boolean }>}
 */
async function searchFiles(args) {
  const pattern = toLinePattern(args);
  const found = (await findWorkspaceFiles(args.include, args.exclude)).sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  const uris = found.slice(0, MAX_FILES);
  const openDocuments = new Map(vscode.workspace.textDocuments.map((document) => [document.uri.toString(), document]));
  const files = [];
  let matchCount = 0;
  for (let start = 0; start < uris.length && matchCount < args.max_results; start += READ_BATCH_SIZE) {
    const batch = uris.slice(start, start + READ_BATCH_SIZE);
    const texts = await Promise.all(batch.map((uri) => readText(uri, openDocuments).catch(() => undefined)));
    batch.forEach((uri, index) => {
      const lines = texts[index] === undefined ? [] : matchingLines(texts[index], pattern);
      const kept = lines.slice(0, args.max_results - matchCount);
      if (kept.length) {
        files.push({ uri, lines: kept });
        matchCount += kept.length;
      }
    });
  }
  return { files, matchCount, fileLimitHit: found.length >= MAX_FILES };
}

module.exports = { searchFiles, MAX_FILES };
