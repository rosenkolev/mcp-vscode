# Live tests

These tests drive real VS Code windows over MCP, the way an agent does. They catch what unit tests
cannot: language servers, debug adapters, shell integration, task terminals, test extensions and
settings behave as VS Code really runs them.

```sh
npm run test:live                                  # every suite
node --test tests/live/windows.test.js             # one suite
LIVE_TESTS_NETWORK=1 npm run test:live             # also what needs the network
LIVE_TESTS_VSCODE=stable npm run test:live         # on a downloaded VS Code instead of yours
```

## Suites

| File | Checks |
|---|---|
| `live.test.js` | Every tool, in one window with the extension loaded from source and the fixture test controller (`fixture-extension/`), on a copy of `fixture/` |
| `windows.test.js` | Three windows of one profile with the packaged extension installed: workspace, folder and single file reach their own window through one port, and another window takes the port when the serving one closes |
| `engines.test.js` | Test results with real test extensions from the Marketplace, one window each: Jest, Vitest, the Node.js test runner and pytest (needs `LIVE_TESTS_NETWORK=1`; uses npm and pip) |

Every suite uses temporary folders for user data and extensions and its own free port, so your settings,
projects and a VS Code with this extension serving port 47391 are not affected. Windows open on screen
while the tests run, and a failed run kills what it started.

## Requirements

- Node.js 20 or later. The tests use only Node's built-in test runner; there is nothing to install.
- VS Code's `code` command on PATH, `VSCODE_CLI` set to its full path (`code.cmd` on Windows), or
  `LIVE_TESTS_VSCODE=stable`, which downloads the latest stable VS Code once into the temp folder.
- For the engines suite: Python 3 (`py` on Windows, `python3` elsewhere).

## Layout

| Path | Holds |
|---|---|
| `harness/vscode.js` | One window with the extension loaded from source |
| `harness/profile.js` | A temporary profile, the .vsix install, and windows opened into it |
| `harness/engine.js` | One window per test engine, with that engine's extension installed |
| `harness/fixture.js` | The temporary folder: fixture copy, settings files, port, cleanup |
| `harness/processes.js` | Launching VS Code and commands, the stable download, killing leftovers, free ports |
| `harness/poll.js` | `eventually` and `sleep` |
| `harness/client.js` | MCP client: `ok`, `fails`, `toolNames`, `instructions`; answers `roots/list` |
| `harness/probe.js` | A client run inside a window's terminal, as an agent would be |
| `suites/*.js` | One suite of `live.test.js` per tool area |
| `fixture/` | Two-folder workspace: tasks, launch configurations and a compound in the workspace file, a folder `launch.json`, files to navigate, edit and search |
| `fixture-extension/` | A test controller with three tests in `a/calc.js` (pass, fail, skip), so the test tools have known results without network |
| `engines/` | One small project per test engine, each with the same three tests |

## Writing a test

Add an `it` to the suite of the tool area, or a new suite file listed in `live.test.js`. Assert on the
lines a tool returns, the way an agent reads them. Use `live.file(...)` to read fixture files after an
edit, `live.writeUserSettings` / `live.writeWorkspaceSettings` for settings, and `eventually` for anything
VS Code does in the background, such as a language server starting. Suites share one window and run in
order, so a suite that changes state puts it back in an `after` hook.

## Limits

- A pending VS Code update blocks new instances: VS Code logs `checkInnoSetupMutex: vscode-updating is held`
  and exits, and the tests time out waiting for the endpoint. Restart VS Code to finish the update, or use
  `LIVE_TESTS_VSCODE=stable`.
- Approving an edit in the Refactor Preview needs a tick in its list, which keyboard commands cannot set
  reliably, so `edit_file` review is checked through discarding.
