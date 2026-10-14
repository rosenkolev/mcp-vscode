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

The tests drive real VS Code windows over MCP, the way an agent does.

| Command | Runs |
|---|---|
| `npm run test:live` | Everything below |
| `npm run test:live:windows` | Only the several-windows suite |
| `LIVE_TESTS_NETWORK=1 npm run test:live` | Also installs an extension from the Marketplace |

- One suite opens a window with the extension loaded from source and calls every tool.
- The other packages the extension, installs it into a temporary profile, and opens three windows of it.

Both use temporary folders and their own port, so they do not touch your settings or a running copy of the
extension. Needs VS Code's `code` command on PATH and Node.js 20+. More in
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
