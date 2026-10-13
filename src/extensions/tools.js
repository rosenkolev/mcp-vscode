'use strict';

const vscode = require('vscode');
const { existingUri } = require('../workspace/paths');
const { manifestText } = require('../shared/text');
const { withTimeout, nextEvent } = require('../shared/async');
const { timeoutProperty } = require('../shared/schema');
const { listInstalled } = require('./cli');

const EXTENSION_ID_PATTERN = /^[\w-]+\.[\w-]+$/;
const LOAD_WAIT_MS = 10000;
const STATES = ['all', 'active', 'inactive', 'disabled', 'uninstalled'];

/**
 * What the extension API does not track: ids uninstalled since activation, which stay loaded until the
 * window reloads, and the CLI's installed list, cached until the installed extensions change.
 * @param {vscode.ExtensionContext} context
 */
function createInventory(context) {
  const uninstalledIds = new Set();
  let cachedList;
  const forgetInstalled = () => {
    cachedList = undefined;
  };
  context.subscriptions.push(vscode.extensions.onDidChange(forgetInstalled));
  return {
    uninstalledIds,
    forgetInstalled,
    installed: () => {
      if (!cachedList) {
        cachedList = listInstalled(context);
        cachedList.catch(forgetInstalled);
      }
      return cachedList;
    },
  };
}

function stateOf(extension, { uninstalledIds }) {
  if (uninstalledIds.has(extension.id.toLowerCase())) {
    return 'uninstalled';
  }
  return extension.isActive ? 'active' : 'inactive';
}

/**
 * Enabled extensions of this window, plus installed ones the window did not load (disabled). Extensions
 * uninstalled in this session stay loaded until the window reloads, so `uninstalledIds` marks them.
 */
async function collectExtensions(includeBuiltin, inventory) {
  const enabled = vscode.extensions.all
    .filter((extension) => includeBuiltin || !extension.packageJSON.isBuiltin)
    .map((extension) => ({
      id: extension.id,
      version: extension.packageJSON.version,
      name: extension.packageJSON.displayName,
      state: stateOf(extension, inventory),
    }));
  const enabledIds = new Set(enabled.map(({ id }) => id.toLowerCase()));
  try {
    const disabled = (await inventory.installed())
      .filter(({ id }) => !enabledIds.has(id.toLowerCase()))
      .map((entry) => ({ ...entry, state: 'disabled' }));
    return { extensions: [...enabled, ...disabled] };
  } catch (error) {
    return { extensions: enabled, warning: `Disabled extensions are not listed: the VS Code CLI failed (${error.message}).` };
  }
}

async function listExtensions({ filter, state, include_builtin }, inventory) {
  const needle = filter?.toLowerCase();
  const { extensions, warning } = await collectExtensions(include_builtin, inventory);
  const lines = extensions
    .filter((extension) => state === 'all' || extension.state === state)
    .filter(({ id, name }) => !needle || `${id} ${name ?? ''}`.toLowerCase().includes(needle))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, version, name, state: current }) => [`${id}@${version}`, current, manifestText(name)].filter(Boolean).join(' - '));
  return [...(warning ? [warning] : []), ...(lines.length ? lines : ['No matching extensions.'])].join('\n');
}

/** An extension id, or the URI of an existing .vsix file given by absolute or workspace-relative path. */
async function toInstallTarget(id) {
  if (id.toLowerCase().endsWith('.vsix')) {
    return existingUri(id);
  }
  return checkedId(id);
}

/** True when the CLI lists `id` as installed, which, for an extension this window did not load, means disabled. */
async function isInstalled(id, inventory) {
  try {
    return (await inventory.installed()).some((entry) => entry.id.toLowerCase() === id.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Runs an install or uninstall command; false when it is still running after the timeout, which happens
 * while VS Code waits for the user in a dialog, such as the one asking to trust a new publisher.
 */
async function finishesInTime(command, target, timeoutSeconds) {
  const { done } = await withTimeout(vscode.commands.executeCommand(command, target), timeoutSeconds * 1000);
  return done;
}

const waitingNote = (action, id, timeoutSeconds) =>
  `${action} ${id} is still waiting after ${timeoutSeconds}s; VS Code is probably asking for confirmation in its window. It finishes once the user answers.`;

/** The loaded extension `id`, waiting up to LOAD_WAIT_MS for VS Code to load one it just installed. */
async function loadedExtension(id) {
  const find = () => vscode.extensions.getExtension(id);
  if (!find()) {
    await nextEvent(vscode.extensions.onDidChange, () => Boolean(find()), LOAD_WAIT_MS);
  }
  return find();
}

async function installExtension({ id, timeout_seconds }, inventory) {
  const target = await toInstallTarget(id);
  // Installed but not loaded means disabled; installing again would change nothing.
  if (typeof target === 'string' && !vscode.extensions.getExtension(id) && (await isInstalled(id, inventory))) {
    return `${id} is already installed but disabled in this window. Enable it in the Extensions view.`;
  }
  if (!(await finishesInTime('workbench.extensions.installExtension', target, timeout_seconds))) {
    return waitingNote('Installing', id, timeout_seconds);
  }
  inventory.uninstalledIds.delete(id.toLowerCase());
  inventory.forgetInstalled();
  const loaded = await loadedExtension(id);
  return loaded
    ? `Installed ${loaded.id}@${loaded.packageJSON.version}.`
    : `Installed ${id}. If list_extensions does not show it as enabled, run Developer: Reload Window.`;
}

function checkedId(id) {
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new Error(`"${id}" is not an extension id of the form publisher.name.`);
  }
  return id;
}

const confirmTimeoutProperty = timeoutProperty(60, 'A dialog left unanswered keeps the operation waiting after it.');

/** @param {vscode.ExtensionContext} context this extension's context; it must not uninstall itself */
function extensionTools(context) {
  const selfId = context.extension.id;
  const inventory = createInventory(context);
  return [
    {
      name: 'list_extensions',
      description:
        'List the VS Code extensions installed for this window: active, inactive (enabled, not yet activated), disabled, or uninstalled but loaded until the window reloads. Built-in extensions are left out by default.',
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'Case-insensitive substring of the extension id or display name.' },
          state: { type: 'string', enum: STATES, default: 'all', description: 'Only extensions in this state.' },
          include_builtin: { type: 'boolean', default: false, description: 'Include extensions that ship with VS Code.' },
        },
      },
      handler: (args) => listExtensions(args, inventory),
    },
    {
      name: 'install_extension',
      description:
        'Install a VS Code extension from the Marketplace by id, or from a .vsix file. Extensions run code on the machine: install only what the user asked for.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Extension id (publisher.name), or the path of a .vsix file.' },
          timeout_seconds: confirmTimeoutProperty,
        },
        required: ['id'],
      },
      handler: (args) => installExtension(args, inventory),
    },
    {
      name: 'uninstall_extension',
      description: 'Uninstall a VS Code extension by id. A running extension stays loaded until the window reloads.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Extension id (publisher.name).' },
          timeout_seconds: confirmTimeoutProperty,
        },
        required: ['id'],
      },
      handler: async ({ id, timeout_seconds }) => {
        if (checkedId(id).toLowerCase() === selfId.toLowerCase()) {
          throw new Error('This extension serves the MCP endpoint and cannot uninstall itself.');
        }
        if (!(await finishesInTime('workbench.extensions.uninstallExtension', id, timeout_seconds))) {
          return waitingNote('Uninstalling', id, timeout_seconds);
        }
        inventory.uninstalledIds.add(id.toLowerCase());
        inventory.forgetInstalled();
        return `Uninstalled ${id}. Reload the window to unload it if it was running.`;
      },
    },
  ];
}

module.exports = { extensionTools };
