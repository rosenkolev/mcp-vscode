# Changelog

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
