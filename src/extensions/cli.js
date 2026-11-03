'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const CLI_TIMEOUT_MS = 30000;

/** URI of the open workspace as VS Code keys it: the .code-workspace file, else the single folder. */
function workspaceKey() {
  return (vscode.workspace.workspaceFile ?? vscode.workspace.workspaceFolders?.[0]?.uri)?.toString();
}

/**
 * The user data folder and profile of this window. The extension's global storage path,
 * `<user data>/User/globalStorage/<extension id>`, gives the folder for every profile. The profile comes
 * from `User/globalStorage/storage.json`, where VS Code keeps the profile of each workspace and the name
 * of each profile; a workspace without an entry uses the default profile.
 */
async function windowScope(globalStorageUri) {
  const parts = globalStorageUri.fsPath.split(path.sep);
  const userIndex = parts.lastIndexOf('User');
  if (userIndex < 0) {
    return {};
  }
  const userDataDir = parts.slice(0, userIndex).join(path.sep);
  const storageFile = path.join(userDataDir, 'User', 'globalStorage', 'storage.json');
  const storage = JSON.parse(await fs.readFile(storageFile, 'utf8').catch(() => '{}'));
  const profileId = storage.profileAssociations?.workspaces?.[workspaceKey()];
  const profile = (storage.userDataProfiles ?? []).find(({ location }) => path.basename(String(location)) === profileId);
  return { userDataDir, profile: profile?.name };
}

/**
 * True when `extension` was installed into its folder: that folder's registry (extensions.json) lists it
 * with install metadata. An extension loaded from source has no such entry, even where the VS Code CLI,
 * pointed at its folder, wrote a registry by scanning it.
 */
async function isInstalledIn(dir, extension) {
  const entries = await fs
    .readFile(path.join(dir, 'extensions.json'), 'utf8')
    .then(JSON.parse)
    .catch(() => undefined);
  const id = extension.id.toLowerCase();
  return Array.isArray(entries) && entries.some((entry) => entry?.identifier?.id?.toLowerCase() === id && entry.metadata != null);
}

/**
 * Folder of the installed extensions: the parent of this extension's own folder once installed. Run from
 * source (development mode), this extension lives elsewhere, and so may other extensions, so it is the
 * folder of another loaded extension that VS Code's registry lists as installed there.
 * @param {vscode.ExtensionContext} context
 */
async function extensionsDir(context) {
  if (context.extensionMode === vscode.ExtensionMode.Production) {
    return path.dirname(context.extension.extensionUri.fsPath);
  }
  const candidates = vscode.extensions.all.filter(
    (extension) => !extension.packageJSON.isBuiltin && extension.id !== context.extension.id && extension.extensionUri.scheme === 'file',
  );
  for (const extension of candidates) {
    const dir = path.dirname(extension.extensionUri.fsPath);
    if (await isInstalledIn(dir, extension)) {
      return dir;
    }
  }
  return undefined;
}

/**
 * CLI arguments that make it read the extensions of this window's user data folder, profile and
 * extensions folder. Throws when the extensions folder is unknown, since the CLI would read the default one.
 */
async function scopeArgs(context) {
  const { userDataDir, profile } = await windowScope(context.globalStorageUri);
  const extensions = await extensionsDir(context);
  if (!extensions) {
    throw new Error('the extensions folder is unknown while this extension runs from source and no installed extension is loaded');
  }
  return [
    ...(userDataDir ? ['--user-data-dir', userDataDir] : []),
    ...(profile ? ['--profile', profile] : []),
    '--extensions-dir',
    extensions,
  ];
}

/**
 * Installed extensions as `{ id, version }`, disabled ones included, read with the VS Code CLI because the
 * API only exposes enabled extensions. Runs the CLI script with the running VS Code binary, the same way
 * the `code` launcher does, so no PATH setup is needed on any platform.
 * @param {vscode.ExtensionContext} context
 */
async function listInstalled(context) {
  const cli = path.join(vscode.env.appRoot, 'out', 'cli.js');
  const args = [cli, ...(await scopeArgs(context)), '--list-extensions', '--show-versions'];
  return new Promise((resolve, reject) => {
    cp.execFile(
      process.execPath,
      args,
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: CLI_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const entries = stdout.split(/\r?\n/).filter((line) => line.includes('@'));
        resolve(entries.map((line) => ({ id: line.slice(0, line.lastIndexOf('@')), version: line.slice(line.lastIndexOf('@') + 1) })));
      },
    );
  });
}

module.exports = { listInstalled };
