'use strict';

const vscode = require('vscode');
const { McpHttpServer } = require('./mcp/server');
const { McpEndpoint } = require('./mcp/endpoint');
const { disabledTools, affectsDisabledTools, checkDisabledTools } = require('./mcp/policy');
const { TaskRunner } = require('./tasks/runner');
const { taskTools } = require('./tasks/tools');
const { TerminalManager } = require('./terminals/manager');
const { terminalTools } = require('./terminals/tools');
const { diagnosticTools } = require('./diagnostics/tools');
const { extensionTools } = require('./extensions/tools');
const { workspaceTools } = require('./workspace/tools');
const { testingTools } = require('./testing/tools');
const { commandTools } = require('./commands/tools');
const { searchTools } = require('./search/tools');
const { navigationTools } = require('./language/navigation');
const { refactorTools } = require('./language/refactor');
const { documentTools } = require('./documents/tools');
const { debugTools } = require('./debug/tools');
const { outputTools } = require('./output/tools');
const vscodeUnofficial = require('./unofficial/vscode-unofficial');

const SERVER_NAME = 'mcp-vscode';
const INSTRUCTIONS =
  'Controls the open VS Code window: runs tasks, shell commands and VS Code commands, searches files and reads the Problems panel. ' +
  'Tasks: list_tasks to find a label, run_task to start it (wait_for_exit for builds, wait_for_pattern for dev servers and watchers), ' +
  'task_status to read state and output, close_task to stop it. ' +
  'Commands: run_in_terminal runs a command in a named terminal and directory and returns its output; read_terminal, clear_terminal. ' +
  'get_diagnostics lists errors and warnings. ' +
  'run_command runs any Command Palette command by id (list_commands finds ids), e.g. formatting a file or reloading the window. ' +
  'search_in_files searches the workspace text like the Search view. ' +
  'Prefer the language-server tools for code: find_definition, find_references, get_hover, document_symbols, workspace_symbols, ' +
  'call_hierarchy, rename_symbol (safe rename) and code_actions (quick fixes). ' +
  'format_document formats with the configured formatter; save_files saves; get_selection returns what the user selected. ' +
  'Debugging: list_debug_configs, start_debugging, debug_control, debug_inspect, breakpoints, stop_debugging. ' +
  'list_output_channels and read_output_channel read the Output panel. ' +
  'list_extensions, install_extension and uninstall_extension manage VS Code extensions. ' +
  'get_workspace describes the open folders; list_tabs, open_file and close_tab handle editor tabs. ' +
  'test_explorer, refresh_tests, run_tests, cancel_test_run and clear_test_results drive the Test Explorer, ' +
  'whose results are not readable: for test output, run the test command with run_in_terminal.';

/** @param {vscode.ExtensionContext} context */
function createTools(context, runner, terminals) {
  return [
    ...taskTools(runner),
    ...terminalTools(terminals),
    ...commandTools(),
    ...searchTools(),
    ...navigationTools(),
    ...refactorTools(),
    ...documentTools(),
    ...diagnosticTools(),
    ...debugTools(context.subscriptions),
    ...extensionTools(context),
    ...workspaceTools(),
    ...testingTools(),
    ...outputTools(),
  ];
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const log = vscode.window.createOutputChannel('MCP VS Code', { log: true });
  vscodeUnofficial.initialize({ logUri: context.logUri, log });
  const runner = new TaskRunner(log);
  const terminals = new TerminalManager();
  const tools = createTools(context, runner, terminals);
  const checkSettings = () => checkDisabledTools(tools.map((tool) => tool.name), context.extension.packageJSON, log);
  const server = new McpHttpServer({
    name: SERVER_NAME,
    version: context.extension.packageJSON.version,
    instructions: INSTRUCTIONS,
    tools,
    disabledTools,
    log,
  });
  const endpoint = new McpEndpoint(server, log);

  context.subscriptions.push(
    log,
    runner,
    terminals,
    endpoint,
    endpoint.registerDefinitionProvider('mcpVscode.server'),
    vscode.commands.registerCommand('mcpVscode.restartServer', () => endpoint.restart()),
    vscode.commands.registerCommand('mcpVscode.showLog', () => log.show()),
    vscode.commands.registerCommand('mcpVscode.copyClaudeCommand', async () => {
      const command = `claude mcp add --transport http --scope user ${SERVER_NAME} ${endpoint.url}`;
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(`Copied: ${command}`);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (McpEndpoint.affects(event)) {
        endpoint.restart();
      }
      if (affectsDisabledTools(event)) {
        log.info(`Disabled tools: ${[...disabledTools()].join(', ') || 'none'}`);
        checkSettings();
      }
    }),
  );

  checkSettings();
  endpoint.restart();
}

function deactivate() {}

module.exports = { activate, deactivate };
