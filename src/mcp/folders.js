'use strict';

const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

/** Pure path rules of window routing; no VS Code or file system access, so they are unit-tested on their own. */

/**
 * Where this user's windows register, per main port. Windows of every profile must find each other,
 * so it is under the temp folder, not under a profile's storage; on POSIX, where the temp folder is
 * shared, the folder name carries the user id and the files are checked for ownership.
 */
function registryDirectory(mainPort) {
  const owner = process.getuid?.();
  return path.join(os.tmpdir(), owner === undefined ? 'mcp-vscode-windows' : `mcp-vscode-windows-${owner}`, String(mainPort));
}

const IGNORES_CASE = process.platform === 'win32' || process.platform === 'darwin';

/** Comparable form of a folder path: resolved, without a trailing separator (except a root), case-folded where paths ignore case. */
function comparable(folder) {
  const resolved = path.resolve(folder);
  const { root } = path.parse(resolved);
  const trimmed = resolved.length > root.length ? resolved.replace(/[/\x5c]+$/, '') : resolved;
  return IGNORES_CASE ? trimmed.toLowerCase() : trimmed;
}

/** True when `inner` is `outer` or inside it. */
function isWithin(inner, outer) {
  const relative = path.relative(comparable(outer), comparable(inner));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * A `file:` root URI as a platform path, UNC shares included on Windows; undefined for other schemes,
 * unreadable URIs, and network hosts on platforms without UNC paths.
 */
function rootPath(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'file:' ? fileURLToPath(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The windows a root folder belongs to, from `windows` (each `{ folders: string[] }`): those whose
 * folder contains the root, the deepest folder first; else those with a folder inside the root.
 * @returns {object[]} the best candidates; one means a match, none or several mean no decision
 */
function windowsOfRoot(windows, root) {
  const containing = windows
    .flatMap((window) => window.folders.filter((folder) => isWithin(root, folder)).map((folder) => ({ window, depth: comparable(folder).length })))
    .sort((a, b) => b.depth - a.depth);
  const deepest = containing.filter(({ depth }) => depth === containing[0]?.depth).map(({ window }) => window);
  const candidates = deepest.length ? deepest : windows.filter((window) => window.folders.some((folder) => isWithin(folder, root)));
  return [...new Set(candidates)];
}

module.exports = { registryDirectory, comparable, isWithin, rootPath, windowsOfRoot };
