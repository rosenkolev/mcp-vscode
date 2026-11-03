# Tool reference

## Conventions

- **Paths** are absolute or relative to the workspace. In a multi-root workspace a relative path may start
  with a folder name, as the tools print paths.
- **Positions** take `path` and a 1-based `line`, plus a `column` or the `symbol` name on that line.
- **Output** of tasks, terminals and the debugger is paged with `since` and `max_lines`, and filtered with
  `filter`, a case-insensitive regex. Each reply ends with the `Next since` to pass on.
- **Waiting**: `wait_for_exit` and `wait_for_pattern` make a call block until done, until a line matches,
  or until `timeout_seconds`.
- **Saving**: editing tools save the files they change unless `save: false`.

## Tools

### Tasks

| Tool | Does |
|---|---|
| `list_tasks` | Tasks VS Code can run, with the state of each run |
| `run_task` | Start a task; `restart` stops a running one first. Its terminal closes `close_delay_seconds` (default 3) after the task ends, unless `keep_open` |
| `task_status` | State, exit code and output of a run; without `name`, every run |
| `close_task` | Stop a task with all its processes and close its terminal |

### Terminals

| Tool | Does |
|---|---|
| `run_in_terminal` | Run a command in a named terminal (default `MCP`) and `cwd`; returns exit code and output. The terminal closes `close_delay_seconds` (default 3) after the command ends, unless `keep_open` |
| `read_terminal` | Output of a terminal's latest or a matching command, also after the terminal closed; without `terminal`, every terminal |
| `send_to_terminal` | Type `text` (with Enter unless `enter: false`) or press Ctrl+C (`interrupt`), also in task terminals |
| `clear_terminal` / `close_terminal` | Clear a terminal; close one, ending what runs in it |

### Code intelligence

| Tool | Does |
|---|---|
| `find_definition` | Definition, type definition, implementation or declaration (`kind`) of a symbol |
| `find_references` | Every reference to a symbol, with the line text |
| `get_hover` | Type, signature and documentation of a symbol |
| `signature_help` | Signatures of a call and the current parameter; `symbol: "fetch("` puts the cursor after it |
| `completions` | IntelliSense suggestions, e.g. after `symbol: "user."`; `filter` narrows |
| `document_symbols` / `workspace_symbols` | Outline of a file; symbols by name across the workspace |
| `call_hierarchy` / `type_hierarchy` | Callers or callees of a function; supertypes or subtypes of a class. Type hierarchy needs a language extension that offers it (Java, C#, C++), not TypeScript |

### Editing

| Tool | Does |
|---|---|
| `edit_file` | Replace exact `old_text` with `new_text`, keeping unsaved changes, as one undo step. `review: true` shows the edits in the Refactor Preview, where you tick the ones to keep and apply; the call waits for you. `show_diff` opens a diff |
| `rename_symbol` | Rename a symbol in every file that uses it |
| `code_actions` | Quick fixes and refactorings for lines (`kind` narrows); `apply: <number>` applies one |
| `format_document` / `save_files` | Format a file with its formatter; save one or all unsaved files |

### Debugging

| Tool | Does |
|---|---|
| `list_debug_configs` / `start_debugging` | Launch configurations; start one, optionally waiting for the first pause |
| `breakpoints` | `list`, `add` (with `condition` or `log_message`) or `remove` (all when no `path`). `exceptions` sets which exceptions pause, e.g. `["uncaught"]` |
| `debug_control` | `continue`, `pause`, `step_over`, `step_into`, `step_out`, `restart`; waits for the next pause |
| `debug_inspect` | Exception, call stack, variables and an evaluated `expression` |
| `debug_output` | What the program printed, and logpoint messages |
| `stop_debugging` | Stop every session |

### Search, problems and output

| Tool | Does |
|---|---|
| `search_in_files` | Matching lines by file; `is_regex`, `case_sensitive`, `whole_word`, `include`, `exclude` |
| `get_diagnostics` | Problems panel entries, errors first; by `path` and `severity` |
| `list_output_channels` / `read_output_channel` | Output channels of extensions; the last lines of one |

### Editors and workspace

| Tool | Does |
|---|---|
| `get_workspace` | Open folders, workspace file, trust and remote state |
| `list_tabs` | Tabs per group, unsaved and preview flags, the cursor and selection |
| `open_file` / `close_tab` | Open a file at a line; close a file's tabs (`save: true` saves unsaved ones) |
| `get_selection` | File, cursor and selected text of the active editor |

### Tests

| Tool | Does |
|---|---|
| `test_explorer` | Test controllers, or the tests discovered in one `file` with their line and last result |
| `refresh_tests` | Find tests again |
| `run_tests` | Run `all`, `failed`, `last`, one `file` (`path`), one `test` (`path` and a `line` inside it) or `tests` of a file by `names`, with `coverage: true` if wanted; waits and returns the result |
| `test_results` | The latest run, also one you started: counts, and the failed tests (or `show: "all"`) with file, line and duration |
| `cancel_test_run` / `clear_test_results` | Cancel the run; clear results |

Results come from the Test Explorer, so they work with any test extension that lists its tests there; the
live tests cover Jest, Vitest, the Node.js test runner and pytest. VS Code does not keep failure messages
or coverage numbers: for those, run the test command with `run_in_terminal`. Results are read from VS
Code's internal storage, which is checked before use; if a VS Code update changes it, the tools say so
instead of reporting wrong results.

### Commands and extensions

| Tool | Does |
|---|---|
| `list_commands` / `run_command` | Command ids; run one with JSON `args`. `file` opens a file first, for editor commands |
| `list_extensions` | Installed extensions and their state |
| `install_extension` / `uninstall_extension` | Install by id or `.vsix` path; uninstall by id |

Useful command ids: `workbench.action.reloadWindow`, `editor.action.organizeImports` (with `file`),
`workbench.action.closeAllEditors`.

## Which window an agent works in

All agents connect to the same port. The window that has it passes each call to the agent's own window:

| Where the agent runs | Its window |
|---|---|
| A VS Code terminal, or a chat panel of an extension | The window the agent's process belongs to |
| Another terminal app | The window with the agent's folder open (from the MCP `roots` it sends) |
| VS Code chat (Copilot) | Its own window, directly |

When no window or several windows match, the call fails and says why. When the window holding the port
closes, another one takes it within a second.

## Output channels

`read_output_channel` reads VS Code's log files, which is not a public API. The layout is checked before
use; when it changes, the tool says so. Core channels such as Tasks are not covered.
