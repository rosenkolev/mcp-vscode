# MCP VS Code

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![VS Code](https://img.shields.io/badge/VS%20Code-%E2%89%A51.101-007ACC?logo=visualstudiocode)
![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6E56CF)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![License](https://img.shields.io/badge/license-MIT-green)

Lets an AI agent such as Claude Code work inside your VS Code window the way you do. Everything it does is
visible in the window. Works with any [MCP](https://modelcontextprotocol.io) client.

## Features

| Area | What the agent can do |
|---|---|
| Tasks | Run `tasks.json` tasks and npm scripts, wait until done or ready, read the output, stop them |
| Terminals | Run commands and read their exit code and output, answer prompts, press Ctrl+C |
| Code intelligence | Go to definition, find references, hover, signatures, completions, symbols, call hierarchy |
| Editing | Edit files through the editor, with optional review before applying; rename, quick fixes, format |
| Debugging | Start debugging, set breakpoints and logpoints, step, read variables, exceptions and program output |
| Search | Search the workspace like the Search view |
| Problems and Output | Read errors, warnings and the Output panel of extensions |
| Editors | Open, list and close tabs; read the cursor and selection |
| Tests | Discover and run tests in the Test Explorer |
| Commands and extensions | Run any Command Palette command; list, install and uninstall extensions |

Every feature and its options: [tool reference](TOOLS.md).

**Several windows, one setup.** Every agent connects to the same address and works in its own window,
whether it runs in a VS Code terminal, a chat panel, or another terminal app in the project folder.

## Quick start

1. Install the extension. The status bar shows **MCP VS Code** once it is ready.
2. Connect your agent to `http://127.0.0.1:47391/mcp`:

| Client | Setup |
|---|---|
| Claude Code | Run **MCP VS Code: Copy Claude Code Setup Command** and paste it in a terminal |
| VS Code chat (Copilot) | Nothing to do |
| Cursor | In `~/.cursor/mcp.json`: `{ "mcpServers": { "mcp-vscode": { "url": "http://127.0.0.1:47391/mcp" } } }` |
| Codex | In `~/.codex/config.toml`: `[mcp_servers.mcp-vscode]` with `url = "http://127.0.0.1:47391/mcp"` |
| Claude Desktop and other stdio clients | Command `npx`, arguments `["-y", "mcp-remote", "http://127.0.0.1:47391/mcp"]` |

3. Ask the agent to "list the VS Code tasks".

## Security

- Only requests from this computer are accepted, and never from a web page.
- Set `mcpVscode.authToken` to require a password (bearer token) from every client.
- Turn off tools with `mcpVscode.disabledTools`, e.g. `["run_command", "run_in_terminal"]`. A workspace can
  turn off more tools, but never turn back on one you turned off.

## Settings

| Setting | Default | Does |
|---|---|---|
| `mcpVscode.enabled` | `true` | Serve MCP from this window |
| `mcpVscode.port` | `47391` | Port agents connect to |
| `mcpVscode.authToken` | `""` | Token clients must send; user settings only |
| `mcpVscode.disabledTools` | `[]` | Tools agents cannot see or run |

Commands (Command Palette, under **MCP VS Code**): **Copy Claude Code Setup Command**, **Restart Server**,
**Show Log**.

## Limits

- Claude Code connects when it starts; if VS Code started later, reconnect with `/mcp`.
- Terminal output needs a shell with VS Code shell integration (PowerShell, bash, zsh, fish), not cmd.exe.
- Language tools are only as good as the installed language extension.
- Remote windows (SSH, WSL, containers) are not supported.
- Test results and notifications cannot be read through the VS Code API.

## More

- [Tool reference](TOOLS.md): every tool, its options and how agents are matched to windows.
- [Contributing](CONTRIBUTING.md): run from source and run the tests.
- [Changelog](CHANGELOG.md)

## License

`MIT`
