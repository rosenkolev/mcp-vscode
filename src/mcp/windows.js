'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ancestorsOf, ownerOfConnection } = require('./processes');
const { registryDirectory, rootPath, windowsOfRoot } = require('./folders');

/** Ancestors of a client process are cached this long; an agent keeps its pid for its whole session. */
const ANCESTOR_CACHE_MS = 10 * 60 * 1000;
const WRITE_RETRIES = 5;
const WRITE_RETRY_MS = 50;
const OUTSIDE_HINT = 'Start the agent from a terminal of the VS Code window it should work in, or from a folder a VS Code window has open.';

/** Whether a process runs; EPERM means it runs under another user. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The name a window shows: the workspace, else the active file of a window without a folder. */
function windowName() {
  const file = vscode.window.activeTextEditor?.document.uri;
  return vscode.workspace.name ?? (file?.scheme === 'file' ? `${path.basename(file.fsPath)} (no folder)` : 'Empty window');
}

const describe = (entry) => `"${entry.name}"`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when `stat` belongs to this user; always true where files have no owner uid (Windows). */
function ownedByUser(stat) {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
}

/**
 * The VS Code windows of this user that serve MCP, as one JSON file per window (extension host process)
 * in a folder per main port. Each window serves a port of its own and lists the processes that are its
 * own: its extension host and the shells of its terminals. The window on the main port finds the window
 * of a client from the client's process ancestry, or, for a client outside VS Code, from its MCP roots.
 */
class WindowRegistry {
  constructor(log) {
    this.log = log;
    this.pid = process.pid;
    /** @type {string | undefined} */
    this.directory = undefined;
    /** Ancestors per client pid, with the time they were read. @type {Map<number, { chain: number[], at: number }>} */
    this.ancestors = new Map();
    /** Pid of the client process per connection, once known. @type {WeakMap<import('net').Socket, number>} */
    this.socketPids = new WeakMap();
  }

  /** Registers this window as serving `port`; `main` when it also serves `mainPort`. */
  async register(mainPort, port, main) {
    const terminalPids = await Promise.all(vscode.window.terminals.map((terminal) => terminal.processId));
    this.directory = registryDirectory(mainPort);
    const entry = {
      pid: this.pid,
      port,
      main,
      name: windowName(),
      folders: (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
      owners: [this.pid, ...terminalPids.filter(Boolean)],
    };
    await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.write(this.fileOf(this.pid), JSON.stringify(entry));
  }

  /** Writes through a temporary file and a rename, so a reader never sees half a file; retried where a reader holds the file. */
  async write(file, text) {
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.promises.writeFile(`${file}.tmp`, text, { mode: 0o600 });
        await fs.promises.rename(`${file}.tmp`, file);
        return;
      } catch (error) {
        if (attempt >= WRITE_RETRIES) {
          throw error;
        }
        await sleep(WRITE_RETRY_MS * attempt);
      }
    }
  }

  /** Synchronous, so it completes while VS Code shuts the extension host down. */
  unregister() {
    if (this.directory) {
      fs.rmSync(this.fileOf(this.pid), { force: true });
    }
  }

  fileOf(pid) {
    return path.join(this.directory, `${pid}.json`);
  }

  /** Registered windows of this user whose extension host still runs; files of ended windows are deleted. */
  async list() {
    if (!this.directory) {
      return [];
    }
    const names = await fs.promises.readdir(this.directory).catch(() => []);
    const entries = await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map((name) => this.read(name)));
    return entries.filter(Boolean);
  }

  async read(name) {
    const file = path.join(this.directory, name);
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (!stat || !ownedByUser(stat)) {
      return undefined;
    }
    if (!isAlive(Number(path.basename(name, '.json')))) {
      await fs.promises.rm(file, { force: true });
      return undefined;
    }
    // A file being replaced reads as invalid JSON; that window is left out this time.
    const entry = await fs.promises.readFile(file, 'utf8').then(JSON.parse, () => undefined);
    const valid =
      entry && Number.isInteger(entry.port) && entry.port > 0 && Array.isArray(entry.folders) && Array.isArray(entry.owners) && typeof entry.name === 'string';
    return valid ? entry : undefined;
  }

  /** Pid of the process behind `socket`, found once per connection. */
  async pidOfSocket(socket) {
    const known = this.socketPids.get(socket);
    if (known !== undefined) {
      return known;
    }
    const pid = await ownerOfConnection(socket.remotePort, socket.localPort);
    if (pid !== undefined) {
      this.socketPids.set(socket, pid);
    }
    return pid;
  }

  async ancestorsOfClient(pid) {
    let cached = this.ancestors.get(pid);
    if (!cached || Date.now() - cached.at > ANCESTOR_CACHE_MS || !isAlive(pid)) {
      cached = { chain: await ancestorsOf(pid), at: Date.now() };
      this.ancestors.set(pid, cached);
      [...this.ancestors.keys()].filter((key) => !isAlive(key)).forEach((key) => this.ancestors.delete(key));
    }
    return cached.chain;
  }

  /**
   * The window a client process runs in: the window whose extension host or terminal shell is the
   * nearest ancestor of the process behind `socket`. Undefined when the client runs outside every window.
   * @param {import('net').Socket} socket
   */
  async windowOfConnection(socket) {
    const pid = await this.pidOfSocket(socket);
    if (pid === undefined) {
      return undefined;
    }
    const [chain, windows] = await Promise.all([this.ancestorsOfClient(pid), this.list()]);
    for (const ancestor of chain) {
      const window = windows.find((entry) => entry.owners.includes(ancestor));
      if (window) {
        return window;
      }
    }
    return undefined;
  }

  /**
   * The window of a client outside VS Code, from its MCP roots; the first file root decides. Throws
   * when no window or several windows qualify.
   */
  async windowOfRoots(roots) {
    const root = roots.map((candidate) => rootPath(candidate?.uri)).find(Boolean);
    if (!root) {
      throw new Error(`This MCP client runs outside VS Code and sent no folder (MCP roots), so its VS Code window is unknown. ${OUTSIDE_HINT}`);
    }
    const windows = await this.list();
    const matches = windowsOfRoot(windows, root);
    if (matches.length === 1) {
      return matches[0];
    }
    throw new Error(
      matches.length
        ? `${root} matches several VS Code windows: ${matches.map(describe).join(', ')}. ${OUTSIDE_HINT}`
        : `No VS Code window has ${root} open. Open windows: ${windows.map(describe).join(', ') || 'none'}.`,
    );
  }
}

module.exports = { WindowRegistry, isAlive };
