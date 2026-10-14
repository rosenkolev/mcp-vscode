'use strict';

const cp = require('child_process');
const fs = require('fs/promises');
const net = require('net');
const path = require('path');

const IS_WINDOWS = process.platform === 'win32';

/** Whether a process runs. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Full path of a command on PATH (`name.cmd` on Windows), which .cmd scripts need to find their own folder. */
async function onPath(name, notFound = `${name} not found on PATH.`) {
  const file = IS_WINDOWS ? `${name}.cmd` : name;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, file);
    if (await fs.stat(candidate).then((stat) => stat.isFile(), () => false)) {
      return candidate;
    }
  }
  throw new Error(notFound);
}

/**
 * Full path of the VS Code command line: $VSCODE_CLI, else `code` found on PATH. The full path matters on
 * Windows, where code.cmd finds VS Code relative to its own folder and fails when started by bare name.
 */
async function cliPath() {
  return process.env.VSCODE_CLI ?? onPath('code', 'VS Code command line not found: put `code` on PATH or set VSCODE_CLI.');
}

/**
 * The environment without what a VS Code process passes to its children. Run from a VS Code terminal or
 * from an agent inside VS Code, `ELECTRON_RUN_AS_NODE` and the `VSCODE_*` variables of the extension host
 * would make the new VS Code run as a plain Node process instead of opening a window.
 */
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ELECTRON_RUN_AS_NODE|VSCODE_)/i.test(name)));
}

/** Quotes one argument for cmd.exe, which runs .cmd scripts: special characters are escaped, the rest double-quoted. */
function quoteForCmd(value) {
  return `"${value.replace(/[%^&|<>"]/g, '^$&')}"`;
}

/** Spawn arguments for `file` with `args`: through cmd.exe on Windows, since .cmd scripts need a shell. */
function spawnSpec(file, args) {
  return IS_WINDOWS ? [[file, ...args].map(quoteForCmd).join(' '), [], { shell: true }] : [file, args, {}];
}

/** Starts a command detached, so it outlives the test process; resolves once it has spawned. */
async function launch(file, args) {
  const [command, commandArgs, shell] = spawnSpec(file, args);
  const child = cp.spawn(command, commandArgs, { ...shell, stdio: 'ignore', windowsHide: true, detached: !IS_WINDOWS, env: cleanEnvironment() });
  child.unref();
  await new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error(`Cannot start ${path.basename(file)}: ${error.message}`)));
    child.once('spawn', resolve);
  });
}

/** Runs a command to its end and resolves with its output; rejects with the output on a failure exit code. */
function runToEnd(file, args, options = {}) {
  const [command, commandArgs, shell] = spawnSpec(file, args);
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, commandArgs, { ...shell, windowsHide: true, env: cleanEnvironment(), ...options });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(`${path.basename(file)} exited with ${code}: ${output.slice(-2000)}`))));
  });
}

/** Pids of the running processes whose command line contains `marker`, e.g. a test's user-data folder. */
async function processesMentioning(marker) {
  if (IS_WINDOWS) {
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`;
    const output = await runToEnd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).catch(() => '');
    return output.split(/\r?\n/).map(Number).filter(Boolean);
  }
  const output = await runToEnd('pgrep', ['-f', marker]).catch(() => '');
  return output.split('\n').map(Number).filter(Boolean);
}

/** Kills every process whose command line contains `marker`, so a failed run leaves no VS Code behind. */
async function killProcessesMentioning(marker) {
  for (const pid of await processesMentioning(marker)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

module.exports = { isAlive, freePort, onPath, cliPath, launch, runToEnd, killProcessesMentioning };
