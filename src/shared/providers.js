'use strict';

const vscode = require('vscode');

/**
 * Results of a built-in language-feature command (`vscode.execute*Provider`, `vscode.prepare*`, ...) as an
 * array: empty when no provider answers, one item when it returns a single result.
 */
async function provide(command, ...args) {
  return [(await vscode.commands.executeCommand(command, ...args)) ?? []].flat();
}

module.exports = { provide };
