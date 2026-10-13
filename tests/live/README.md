# Live tests

These tests drive a real VS Code window over MCP, the way an agent does. They catch what unit tests
cannot: language servers, debug adapters, shell integration, task terminals and settings behave as
VS Code really runs them.

```sh
npm run test:live                         # all suites, about 30 seconds
LIVE_TESTS_NETWORK=1 npm run test:live    # also installs an extension from the Marketplace
```

## What a run does

1. Copies `fixture/` into a new temporary folder and picks a free port.
2. Starts VS Code with its own user data and extensions folders in that temporary folder, this
   extension loaded from source (`--extensionDevelopmentPath`), and the fixture workspace open.
3. Waits for the MCP endpoint, then runs the suites in `suites/` in order, one window for all of them.
4. Closes the window and deletes the temporary folder.

Nothing touches your own settings, extensions or projects. A window opens on screen while the tests run.

## Requirements

- VS Code with its `code` command on PATH, or `VSCODE_CLI` set to the full path of the command line
  (`code.cmd` on Windows).
- Node.js 20 or later. The tests use only Node's built-in test runner; there is nothing to install.

## Layout

| Path | Holds |
|---|---|
| `live.test.js` | Starts and stops VS Code around the suites |
| `harness/vscode.js` | Isolated VS Code launch, settings writes, `eventually` for polling |
| `harness/client.js` | MCP client: `ok`, `fails`, `toolNames`, `instructions` |
| `suites/*.js` | One suite per tool area |
| `fixture/` | Two-folder workspace: tasks, launch configurations and a compound in the workspace file, a folder `launch.json`, files to navigate, edit and search |

## Writing a test

Add an `it` to the suite of the tool area, or a new suite file listed in `live.test.js`. Assert on the
lines a tool returns, the way an agent reads them. Use `live.file(...)` to read fixture files after an
edit, `live.writeUserSettings` / `live.writeWorkspaceSettings` for settings, and `eventually` for anything
VS Code does in the background, such as a language server starting. Suites share one window and run in
order, so a suite that changes state puts it back in an `after` hook.

## Limits

- The isolated profile has no test extension, so Test Explorer runs are covered only without tests.
- A fresh profile asks to trust a publisher before installing from the Marketplace. The network test
  then checks that `install_extension` returns after its timeout instead of waiting for the answer.
