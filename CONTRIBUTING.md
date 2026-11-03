# Contributing

The extension has no dependencies and no build step: `src/` is the extension.

## Run from source

Open this folder in VS Code and run the extension in an Extension Development Host, or start one from
a terminal:

```sh
code --extensionDevelopmentPath=. path/to/a/project
```

Use a port other than 47391 (`mcpVscode.port`) if you also have the installed extension running.

## Tests

The tests drive real VS Code windows over MCP, the way an agent does. `npm run test:live` runs them all;
one suite alone: `node --test tests/live/<suite>.test.js`.

| Suite | Checks |
|---|---|
| `live.test.js` | Every tool, in one window with the extension loaded from source |
| `windows.test.js` | Three windows of one profile with the packaged extension installed |
| `engines.test.js` | Test results with real test extensions: Jest, Vitest, Node.js test runner, pytest |

| Variable | Effect |
|---|---|
| `LIVE_TESTS_NETWORK=1` | Also run what needs the network: a Marketplace install, and the engines suite (npm, pip) |
| `LIVE_TESTS_VSCODE=stable` | Use a downloaded VS Code instead of yours, e.g. when a pending VS Code update blocks new windows |

The suites use temporary folders and their own port, so they do not touch your settings or a running copy
of the extension. Needs Node.js 20+, VS Code's `code` command on PATH (or `LIVE_TESTS_VSCODE=stable`), and for the
engines Python 3 (`py` on Windows, `python3` elsewhere). More in
[tests/live/README.md](tests/live/README.md).

## Code

- Each tool area has a folder in `src/` with a `tools.js` that lists its tools.
- A new tool also goes into the `mcpVscode.disabledTools` list in `package.json`, [TOOLS.md](TOOLS.md),
  and a live test.

## Releasing

1. Raise `version` in package.json and add its entry to CHANGELOG.md.
2. Run `LIVE_TESTS_NETWORK=1 npm run test:live`, then commit.
3. Tag and push: `git tag v1.1.0 && git push origin main v1.1.0`.

Pushing the tag runs the `Publish` GitHub workflow. It checks the tag matches `version`, packages the
extension, publishes it to the VS Code Marketplace, and attaches the `.vsix` to a GitHub release.

- The package holds only what `files` in package.json lists: `src/**/*.js`, the icon, the README, the
  changelog and the license. Check it with `npm run package:list`.
- Run the workflow by hand with mode `package` to only build the `.vsix` (it is in the run's artifacts),
  or `publish` to publish the current branch.
- The workflow signs in to the Marketplace with a Microsoft Entra ID managed identity through GitHub OIDC,
  so no token is stored. Its mode `show-identity` prints the id to add as a member of the publisher.
