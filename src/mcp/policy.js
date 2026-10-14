'use strict';

const vscode = require('vscode');

const SETTINGS_SECTION = 'mcpVscode';
const DISABLED_TOOLS_SETTING = 'disabledTools';

/**
 * Names of the tools disabled in any settings scope. The scopes add up instead of overriding each other,
 * so a workspace's settings can disable more tools but cannot re-enable one disabled in user settings.
 * @returns {Set<string>}
 */
function disabledTools() {
  const inspected = vscode.workspace.getConfiguration(SETTINGS_SECTION).inspect(DISABLED_TOOLS_SETTING);
  const scopes = [inspected?.globalValue, inspected?.workspaceValue];
  return new Set(scopes.flatMap((names) => (Array.isArray(names) ? names : [])));
}

/** True when a configuration change touches the disabled tools. */
function affectsDisabledTools(event) {
  return event.affectsConfiguration(`${SETTINGS_SECTION}.${DISABLED_TOOLS_SETTING}`);
}

/**
 * Warns about setting values that name no tool, which would disable nothing, and about tools the
 * setting's autocomplete list in package.json lacks, so the two stay in sync.
 */
function checkDisabledTools(toolNames, packageJSON, log) {
  const known = new Set(toolNames);
  const unknown = [...disabledTools()].filter((name) => !known.has(name));
  if (unknown.length) {
    log.warn(`${SETTINGS_SECTION}.${DISABLED_TOOLS_SETTING} names unknown tools, which stay unaffected: ${unknown.join(', ')}`);
  }
  const listed = new Set(
    packageJSON.contributes?.configuration?.properties?.[`${SETTINGS_SECTION}.${DISABLED_TOOLS_SETTING}`]?.items?.enum ?? [],
  );
  const unlisted = toolNames.filter((name) => !listed.has(name));
  if (unlisted.length) {
    log.warn(`Tools missing from the ${DISABLED_TOOLS_SETTING} list in package.json: ${unlisted.join(', ')}`);
  }
}

module.exports = { disabledTools, affectsDisabledTools, checkDisabledTools };
