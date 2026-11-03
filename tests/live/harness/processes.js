'use strict';

const cp = require('child_process');
const fs = require('fs/promises');
const { createWriteStream } = require('fs');
const https = require('https');
const net = require('net');
const os = require('os');
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

/** Download of the latest stable VS Code per platform, and where its command line is inside it. */
const STABLE_BUILDS = {
  win32: { build: 'win32-x64-archive', file: 'vscode.zip', cli: ['bin', 'code.cmd'] },
  linux: { build: 'linux-x64', file: 'vscode.tar.gz', cli: ['VSCode-linux-x64', 'bin', 'code'] },
  darwin: { build: 'darwin-universal', file: 'vscode.zip', cli: ['Visual Studio Code.app', 'Contents', 'Resources', 'app', 'bin', 'code'] },
};

/** Downloads `url` to `file`, following redirects. */
function download(url, file) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(new URL(res.headers.location, url).href, file).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download of ${url} failed: HTTP ${res.statusCode}`));
          return;
        }
        const out = createWriteStream(file);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        // A dropped connection fails the response, which pipe() does not pass on to the file.
        res.on('error', reject);
        res.on('aborted', () => reject(new Error(`Download of ${url} was cut off.`)));
      })
      .on('error', reject);
  });
}

/**
 * The command line of the latest stable VS Code, downloaded once into a cache in the temp folder. The
 * archive edition has no installer, so a pending update of the installed VS Code cannot block it. It is
 * unpacked into a side folder and moved into place only when complete, so an interrupted run leaves no
 * half-unpacked copy behind for the next run.
 */
async function stableCliPath() {
  const target = STABLE_BUILDS[process.platform];
  if (!target) {
    throw new Error(`LIVE_TESTS_VSCODE=stable has no VS Code download for ${process.platform}.`);
  }
  const dir = path.join(os.tmpdir(), 'mcp-vscode-test-vscode', process.platform);
  const cli = path.join(dir, ...target.cli);
  if (await fs.stat(cli).then(() => true, () => false)) {
    return cli;
  }
  const unpacking = `${dir}.unpacking`;
  await fs.rm(unpacking, { recursive: true, force: true });
  await fs.mkdir(unpacking, { recursive: true });
  const archive = path.join(unpacking, target.file);
  console.log(`Downloading VS Code (${target.build}) for the live tests...`);
  await download(`https://update.code.visualstudio.com/latest/${target.build}/stable`, archive);
  // tar unpacks zip files too on Windows 10 and later.
  await runToEnd('tar', process.platform === 'linux' ? ['-xzf', archive, '-C', unpacking] : ['-xf', archive, '-C', unpacking]);
  await fs.rm(archive, { force: true });
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rename(unpacking, dir);
  return cli;
}

let stableCli;

/**
 * Full path of the VS Code command line: $VSCODE_CLI; a downloaded stable VS Code with
 * LIVE_TESTS_VSCODE=stable; else `code` found on PATH. The full path matters on Windows, where code.cmd
 * finds VS Code relative to its own folder and fails when started by bare name.
 */
async function cliPath() {
  if (process.env.VSCODE_CLI) {
    return process.env.VSCODE_CLI;
  }
  if (process.env.LIVE_TESTS_VSCODE === 'stable') {
    stableCli ??= stableCliPath();
    return stableCli;
  }
  return onPath('code', 'VS Code command line not found: put `code` on PATH, set VSCODE_CLI, or set LIVE_TESTS_VSCODE=stable.');
}

/**
 * The environment without what the test's own parents set for their children:
 * - `ELECTRON_RUN_AS_NODE` and `VSCODE_*`, from a VS Code terminal or an agent inside VS Code, would make
 *   the new VS Code run as a plain Node process instead of opening a window;
 * - `NODE_TEST_CONTEXT`, from `node --test`, would make test runs inside the window (the Node.js test
 *   extension's `node --test`) report to this test run instead of to their extension.
 */
function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ELECTRON_RUN_AS_NODE|VSCODE_|NODE_TEST_CONTEXT$)/i.test(name)));
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
