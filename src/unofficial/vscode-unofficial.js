'use strict';

/*
 * vscode-unofficial: what the `vscode` API does not offer, shaped like it (`vscodeUnofficial.outputChannels.list()`
 * next to `vscode.window.createOutputChannel()`) and built on VS Code internals that are not a public contract.
 * Each capability verifies its internal before first use, by writing a marker and reading it back, and fails
 * with NOT_SUPPORTED instead of guessing when the internal has changed. Call `initialize` once on activation.
 *
 * outputChannels: VS Code mirrors every extension Output channel to a file under the window's log folder:
 *   log channels   (createOutputChannel(name, { log: true }))  <window>/exthost/<extension id>/<name>.log
 *   plain channels (createOutputChannel(name))                  <window>/exthost/output_logging_<time>/<n>-<name>.log
 */

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const NOT_SUPPORTED = 'API is no longer supported: this VS Code version stores Output channels differently.';
const NOT_INITIALIZED = 'vscode-unofficial is not initialized; call initialize() on activation.';
const PLAIN_DIR_PREFIX = 'output_logging_';
const PLAIN_FILE_PATTERN = /^\d+-(.+)\.log$/;
const LOG_FILE_PATTERN = /^(.+)\.log$/;
const PROBE_CHANNEL = 'MCP VS Code Probe';
const PROBE_TIMEOUT_MS = 3000;
const PROBE_POLL_MS = 100;

/** This extension's log folder and log channel, set by `initialize`. */
let host;
/** Pending or passed layout verification; reset after a failure so the next call checks again. */
let verified;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readText = (file) => fs.readFile(file, 'utf8').catch(() => undefined);
const listDir = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => []);
const exthostDir = () => path.dirname(host.logUri.fsPath);

/** `{ name, file }` of the files in `dir` whose name matches `pattern`; the first group is the channel name. */
async function channelFiles(dir, pattern) {
  return (await listDir(dir))
    .map((entry) => ({ name: entry.isFile() && pattern.exec(entry.name)?.[1], file: path.join(dir, entry.name) }))
    .filter(({ name }) => name && name !== PROBE_CHANNEL);
}

/** True once the file that `findFile` resolves contains `marker`; channel writes are flushed asynchronously. */
async function markerArrives(findFile, marker) {
  for (let waited = 0; waited <= PROBE_TIMEOUT_MS; waited += PROBE_POLL_MS) {
    const file = await findFile();
    if (file && (await readText(file))?.includes(marker)) {
      return true;
    }
    await sleep(PROBE_POLL_MS);
  }
  return false;
}

async function plainDir() {
  const dirs = (await listDir(exthostDir())).filter((entry) => entry.isDirectory() && entry.name.startsWith(PLAIN_DIR_PREFIX));
  const latest = dirs.map((entry) => entry.name).sort().pop();
  return latest && path.join(exthostDir(), latest);
}

async function plainChannels() {
  const dir = await plainDir();
  return dir ? channelFiles(dir, PLAIN_FILE_PATTERN) : [];
}

async function logChannels() {
  const dirs = (await listDir(exthostDir())).filter((entry) => entry.isDirectory() && !entry.name.startsWith(PLAIN_DIR_PREFIX));
  const perExtension = await Promise.all(
    dirs.map(async ({ name: extension }) =>
      (await channelFiles(path.join(exthostDir(), extension), LOG_FILE_PATTERN)).map((channel) => ({ ...channel, extension })),
    ),
  );
  return perExtension.flat();
}

async function plainProbeFile() {
  const dir = await plainDir();
  const entry = dir && (await listDir(dir)).find((candidate) => PLAIN_FILE_PATTERN.exec(candidate.name)?.[1] === PROBE_CHANNEL);
  return entry && path.join(dir, entry.name);
}

/** Writes a marker to a channel of each kind and reads it back from where the layout says it lands. */
async function verifyLayouts() {
  const marker = `layout probe ${randomUUID()}`;
  const probe = vscode.window.createOutputChannel(PROBE_CHANNEL);
  try {
    host.log.info(marker);
    probe.appendLine(marker);
    const logFile = path.join(host.logUri.fsPath, `${host.log.name}.log`);
    const results = await Promise.all([markerArrives(async () => logFile, marker), markerArrives(plainProbeFile, marker)]);
    return results.every(Boolean);
  } finally {
    probe.dispose();
  }
}

/** Every channel with its file, once the layouts are verified. */
async function channels() {
  if (!host) {
    throw new Error(NOT_INITIALIZED);
  }
  verified ??= verifyLayouts()
    .catch(() => false)
    .then((ok) => ok || (verified = undefined));
  if (!(await verified)) {
    throw new Error(NOT_SUPPORTED);
  }
  return [...(await logChannels()), ...(await plainChannels())].sort((a, b) => a.name.localeCompare(b.name));
}

const outputChannels = {
  /** @returns {Promise<{ name: string, extension?: string }[]>} the Output channels of extensions */
  list: async () => (await channels()).map(({ name, extension }) => ({ name, extension })),

  /** @returns {Promise<string[]>} the lines of the channel named exactly `name` */
  read: async (name) => {
    const channel = (await channels()).find((candidate) => candidate.name === name);
    const text = channel && (await readText(channel.file));
    if (text === undefined) {
      throw new Error(channel ? NOT_SUPPORTED : `No Output channel "${name}".`);
    }
    return text.split(/\r?\n/).filter(Boolean);
  },
};

/**
 * @param {{ logUri: vscode.Uri, log: vscode.LogOutputChannel }} options the extension context's `logUri`
 * and the extension's log channel, used to locate and verify the log layout
 */
function initialize(options) {
  host = options;
  verified = undefined;
}

module.exports = { initialize, outputChannels };
