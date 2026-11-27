# Changelog

## 1.3.0

### Added

- `mcpVscode.maxWaitSeconds` (default 50): longest wait of one call, as clients such as Claude Code end
  calls after 60 s; the reply says to call again to keep waiting.

### Fixed

- `send_to_terminal` with `interrupt` and `text`: waits for the command to stop, then runs the text as a
  new command.
- `wait_for_pattern` replies show the matched line.
- Terminals start without a git pager, so `git diff` and `git log` do not hang.
- `run_in_terminal` names the default shell, e.g. Windows PowerShell 5.1.
- `get_diagnostics` with a file path checks a file no editor had open.
- `format_document` calls run one at a time; a "Model is disposed!" failure is retried.
- `run_command` passes any JSON `args` to the command, instead of failing with "unsupported schema type".

## 1.2.0

### Added

- `run_tests` waits for the run and returns passed, failed and skipped tests with file, line and
  duration. Scopes: `all`, `failed`, `last`, `file`, `test` (at a line), `tests` (by name); optional
  `coverage`.
- `test_results` reads the latest run, also one started by the user.
- `test_explorer` lists the tests of a file with line and last result.
- Works with any Test Explorer extension; live tests cover Jest, Vitest, Node.js test runner and pytest.

### Changed

- Terminals of `run_in_terminal` and `run_task` close 3 seconds after the end; `close_delay_seconds`
  sets the delay, `keep_open` keeps them.
- `run_tests` scope `current_file` is now `file`, with `path`; it needs no open editor.
- Test tools open the Testing view when a file's tests are not loaded yet, keeping editor focus.

### Fixed

- `list_extensions` finds the extensions folder when the extension runs from source.

## 1.1.0

### Added

- Several windows: every agent connects to the one port and works in its own VS Code window, found from
  the agent's process tree, or from its MCP roots when it runs outside VS Code. Works for folder,
  workspace and single-file windows and any MCP client; another window takes the port within a second
  when the serving one closes. VS Code chat in each window uses that window's own port.
- `edit_file`: exact text replacement through the editor, keeping unsaved changes, as one undoable step;
  `review` lists the edits in the Refactor Preview for the user to apply or discard; `show_diff` opens a
  diff.
- `signature_help`, `completions` and `type_hierarchy`.
- `debug_output` reads program and Debug Console output, logpoints included; `debug_inspect` shows the
  exception a session paused on; `breakpoints` with `action: "exceptions"` sets which exceptions pause,
  e.g. `["uncaught"]`.
- `send_to_terminal` (type text, Ctrl+C), also into task terminals, and `close_terminal`.
- `mcpVscode.authToken`: optional bearer token, read from user settings only.

### Changed

- Terminals of `run_in_terminal` and `run_task` close when the command or task ends, unless
  `keep_open`. A closed terminal's output stays readable with `read_terminal`.
- `mcpVscode.port` must be a whole number from 1 to 65535.
- README: quick start per client, features with their tools, security section.

### Fixed

- A terminal name can be reused at once, even while VS Code is still closing the old terminal; two calls
  can no longer share one terminal.
- Tasks: a replaced or disposed run no longer stays "running"; typing into a finished task no longer
  raises an error; arguments are quoted for the shell VS Code uses, which is now the default terminal
  shell rather than cmd.exe.
- Debugging: stops reported without a thread id are seen; a failed start no longer leaks a listener; one
  unreadable scope no longer fails `debug_inspect`.
- Edit tools report files that could not be saved; `code_actions` rejects `end_line` before `line`.
- The endpoint answers oversized requests with 413, empty batches with an error, and keeps retrying the
  main port after a failed registration.

## 1.0.0

First release: tasks, terminals, Command Palette commands, search, language-server navigation and
refactoring, formatting, diagnostics, debugging, Output channels, editor tabs, the Test Explorer and
extension management over MCP, plus the `mcpVscode.disabledTools` setting.
