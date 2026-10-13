# MCP VS Code

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.101-007ACC?logo=visualstudiocode)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

Lets an AI agent such as Claude Code work inside your VS Code window, the way you do: run tasks, terminal
commands and Command Palette commands, navigate and refactor code with the language servers, debug, search
files, read the Problems and Output panels, and manage tabs, tests and extensions. Everything it does is
visible in the window. The extension serves the
[Model Context Protocol](https://modelcontextprotocol.io) on `127.0.0.1:47391`.

## Features

- **Tasks**: run any task from `tasks.json` or auto-detected npm scripts, wait for exit or for a
  "ready" line, read the output, stop it.
- **Terminals**: run shell commands in named terminals and read their exit code and output, including
  commands you type yourself.
- **Commands**: run any Command Palette command by id, such as Format Document or Reload Window.
- **Code intelligence**: go to definition, find references, hover, symbols, call hierarchy, safe rename and
  quick fixes, all from the language servers.
- **Debugging**: start a launch configuration, set breakpoints and logpoints, step, read the call stack and
  variables, evaluate expressions.
- **Search**: search the workspace text like the Search view (Ctrl+Shift+F), with regex, case, whole-word
  and include/exclude globs.
- **Problems and Output**: read errors and warnings, and the Output channels of extensions (Git,
  TypeScript, ESLint, ...).
- **Editors**: list, open and close tabs; format and save files; read the cursor and the selected text.
- **Tests**: discover and run tests in the Test Explorer.
- **Extensions**: list, install and uninstall extensions.
- Also listed under `@mcp` in the Extensions view, so VS Code chat agents can use the same tools.

## Settings and commands

| Setting | Default | Does |
|---|---|---|
| `mcpVscode.enabled` | `true` | Serve the MCP endpoint from this window |
| `mcpVscode.port` | `47391` | Port of the endpoint; the first window to bind it serves |
| `mcpVscode.disabledTools` | `[]` | Tools the endpoint neither lists nor runs |

`mcpVscode.disabledTools` restricts what agents can do, for example:

```json
"mcpVscode.disabledTools": ["run_command", "run_in_terminal", "install_extension", "uninstall_extension"]
```

- User and workspace values add up. A workspace can disable more tools, but its settings cannot re-enable a
  tool disabled in user settings.
- Changes apply at once, without a restart. A refused call tells the agent the tool is disabled. Clients
  that cached the tool list see the shorter list after reconnecting (`/mcp` in Claude Code).
- `run_command` and `run_in_terminal` can reach most of what the other tools do, such as installing an
  extension through its command. Disable them too when the goal is a real lockdown.

Commands: **MCP VS Code: Copy Claude Code Setup Command** (copies the `claude mcp add ...` line),
**Restart Server**, **Show Log**.

## Tests

`npm run test:live` starts an isolated VS Code window with this extension loaded from source and calls
every tool over MCP. See [tests/live/README.md](tests/live/README.md).

## Limits

- One window serves the port; other windows show a disconnected status bar item (click to retry).
- Claude Code connects at startup; after starting VS Code later, reconnect with `/mcp`.
- Not readable through the VS Code API: notifications, test results, and the output of tasks VS Code must
  run itself (`dependsOn`, `${input:...}`, inline problem matchers).
- Output channels are read from VS Code's log files, which is not a public API (`src/unofficial`). The
  layout is verified before use; when it no longer matches, the tools say "API is no longer supported".
  Core channels such as Tasks or Extension Host are not covered.
- Language tools answer only as well as the installed language extension. Right after a file is opened its
  server may still be loading, and the tools say so.
- Terminal output needs shell integration (PowerShell, bash, zsh, fish), not cmd.exe. PowerShell reports
  every failed command as exit code 1.
- Only local requests are served: non-local `Host` headers and browser `Origin` headers are refused.

## Full command list

Paths may be absolute or workspace-relative; in a multi-root workspace a relative path may start with a
folder name. Output tools page with `since` / `max_lines` and filter with a case-insensitive regex
`filter`; their reply ends with the `Next since` to pass on. `wait_for_exit`, `wait_for_pattern` and
`timeout_seconds` make a call block. Position tools take `path` and a 1-based `line`, plus `column` or the
`symbol` name on that line. Editing tools save the changed files unless `save: false`.

| Tool | Does |
|---|---|
| `list_tasks` | Tasks VS Code can run, with the state of tracked runs |
| `run_task` | Start a task; optionally wait for exit or an output pattern; `restart` stops a running one first |
| `task_status` | State, exit code and output of a run; without `name`, all tracked runs |
| `close_task` | Stop a task's process tree and close its terminal |
| `run_in_terminal` | Run a shell command in a named terminal (default `MCP`) and `cwd`; returns exit code and output |
| `read_terminal` | Output of a terminal's latest (or a matching) command; without `terminal`, all terminals |
| `clear_terminal` | Clear a terminal and its captured commands |
| `list_commands` | Command ids, with titles of extension-contributed commands; `filter` narrows |
| `run_command` | Run a command by id with JSON `args`; `file` opens and focuses a file first (for editor commands) |
| `search_in_files` | Matching lines grouped by file; `is_regex`, `case_sensitive`, `whole_word`, `include`, `exclude`, `show` |
| `find_definition` | Definition, type definition, implementation or declaration (`kind`) of the symbol at a position |
| `find_references` | Every reference to the symbol at a position, with the line text |
| `get_hover` | Type, signature and documentation of the symbol at a position |
| `document_symbols` / `workspace_symbols` | Outline of a file; symbols by name across the workspace |
| `call_hierarchy` | Callers (`incoming`) or callees (`outgoing`) of the function at a position |
| `rename_symbol` | Rename the symbol at a position in every file that uses it |
| `code_actions` | Quick fixes and refactorings for lines (`kind` narrows); `apply: <number>` applies one |
| `format_document` / `save_files` | Format a file with its configured formatter; save one or all unsaved files |
| `get_selection` | File, cursor and selected text of the active editor |
| `get_diagnostics` | Problems panel entries, errors first; filter by `path` and `severity` |
| `list_output_channels` / `read_output_channel` | Output channels of extensions; last lines of one, with `filter` |
| `list_debug_configs` / `start_debugging` | Launch configurations; start one, optionally `wait_for_pause` |
| `breakpoints` | `list`, `add` (with `condition` or `log_message`) or `remove` breakpoints |
| `debug_control` | `continue`, `pause`, `step_over`, `step_into`, `step_out`, `restart`; waits for the next pause |
| `debug_inspect` / `stop_debugging` | Call stack, variables and an evaluated `expression`; stop all sessions |
| `get_workspace` | Open folders, workspace file, trust and remote state |
| `list_tabs` | Tabs per editor group, unsaved and preview flags, active cursor and selection |
| `open_file` / `close_tab` | Open a file at a line; close a file's tabs (`save: true` for unsaved ones) |
| `test_explorer` | Test controllers with tests, or the tests of one `file` |
| `refresh_tests` / `run_tests` | Rediscover tests; run `all`, `failed`, `last` or `current_file` and wait |
| `cancel_test_run` / `clear_test_results` | Cancel the test run; clear results |
| `list_extensions` | Installed extensions: active, inactive, disabled or uninstalled (until reload) |
| `install_extension` / `uninstall_extension` | Install by id or `.vsix` path; uninstall by id |

Useful `run_command` ids: `workbench.action.reloadWindow` (the connection drops until VS Code is back),
`editor.action.organizeImports` (with `file`), `workbench.action.closeAllEditors`. Arguments are plain JSON,
so commands that need `Uri` or `Position` objects are covered by the dedicated tools above instead.

## License

MIT. See the `LICENSE` file.
