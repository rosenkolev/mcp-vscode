'use strict';

/*
 * testResults: VS Code's Test Explorer keeps the results of finished runs in the window's workspace
 * storage, about half a second after each run ends:
 *   <workspaceStorage>/<workspace id>/testResults/<result id>.json     the run, without failure messages
 * Failure messages, output and coverage numbers stay in memory only; VS Code keeps the newest 128 runs,
 * skips runs an extension marks not to persist, and deletes them all on "Clear All Results". Windows of
 * the same workspace share the folder. This extension's own storage folder is
 * <workspaceStorage>/<workspace id>/<extension id>, so the folder is its sibling. The layout is checked
 * before use and every file's shape before it is trusted. A file of an unknown shape is skipped (VS Code
 * leaves older files behind after an update); only when no stored file is readable does the reader fail
 * with NOT_SUPPORTED instead of guessing.
 */

const vscode = require('vscode');
const fs = require('fs/promises');
const path = require('path');
const { sleep } = require('../shared/async');

const NOT_SUPPORTED = 'API is no longer supported: this VS Code version stores test results differently.';
const NO_STORAGE = 'Test results are kept per folder or workspace; open one to read them.';
const RESULTS_DIR = 'testResults';
const WORKSPACE_MARKER = 'workspace.json';
const RESULT_FILE = /^([0-9a-f-]{36})\.json$/i;
const ARRIVAL_TIMEOUT_MS = 15000;
const EMPTY_RUN_GRACE_MS = 30000;
const ARRIVAL_POLL_MS = 200;
/** Item states of the Test Explorer (TestResultState). */
const STATES = ['unset', 'queued', 'running', 'passed', 'failed', 'skipped', 'errored'];

const isObject = (value) => typeof value === 'object' && value !== null;
const isState = (value) => Number.isInteger(value) && value >= 0 && value < STATES.length;

/** True when a parsed result file has the shape this reader knows. */
function isKnownShape(result) {
  return (
    isObject(result) &&
    typeof result.id === 'string' &&
    Number.isFinite(result.completedAt) &&
    Array.isArray(result.tasks) &&
    Array.isArray(result.items) &&
    result.items.every(
      (entry) =>
        isObject(entry?.item) &&
        typeof entry.item.extId === 'string' &&
        typeof entry.item.label === 'string' &&
        isState(entry.ownComputedState) &&
        Array.isArray(entry.tasks) &&
        entry.tasks.every((task) => isObject(task) && isState(task.state)),
    )
  );
}

/** Test ids nest by NUL: "controller\0folder\0file\0suite\0test". */
const ID_SEPARATOR = '\0';
const parentId = (extId) => extId.slice(0, Math.max(extId.lastIndexOf(ID_SEPARATOR), 0));
/** The last part of a test id, which names a test that never ran; each extension forms it its own way. */
const lastIdPart = (extId) => extId.slice(extId.lastIndexOf(ID_SEPARATOR) + 1);

/** The file path of a stored URI. VS Code writes `fsPath` only when it had computed it, so it is rebuilt. */
function fileOf(uri) {
  if (!isObject(uri) || typeof uri.path !== 'string') {
    return undefined;
  }
  return vscode.Uri.from({ scheme: uri.scheme ?? 'file', authority: uri.authority ?? '', path: uri.path }).fsPath;
}

/**
 * One test of a result: its name path, state, file, line and duration. The name path joins the labels of
 * the test and of its enclosing blocks (describe, suite) in the same file, which have a line range; the
 * file, folder and controller items above them are left out.
 */
function toTest(entry, byId) {
  const { uri, range } = entry.item;
  const file = fileOf(uri);
  const names = [];
  for (let id = entry.item.extId; id; id = parentId(id)) {
    const item = byId.get(id)?.item;
    if (item?.range && file && fileOf(item.uri) === file) {
      names.unshift(item.label);
    }
  }
  const durations = entry.tasks.map((task) => task.duration).filter(Number.isFinite);
  return {
    id: entry.item.extId,
    name: names.join(' > ') || entry.item.label,
    state: STATES[entry.ownComputedState],
    file,
    line: Number.isInteger(range?.startLineNumber) ? range.startLineNumber : undefined,
    durationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : undefined,
  };
}

/**
 * A result in plain terms: `{ id, completedAt, hasCoverage, tests }`. The tests are the innermost items
 * that ran, so a suite or file that failed before any of its tests ran, such as a file that does not load,
 * is reported too, and a run is never shown clean when it broke.
 */
function toResult(result) {
  const byId = new Map(result.items.map((entry) => [entry.item.extId, entry]));
  const ran = (entry) => entry.ownComputedState !== 0;
  const hasTestsThatRan = new Set();
  for (const entry of result.items.filter(ran)) {
    for (let id = parentId(entry.item.extId); id; id = parentId(id)) {
      hasTestsThatRan.add(id);
    }
  }
  // An item that ran while nothing inside it did: a test, or a suite or file that broke before its tests.
  const tests = result.items.filter((entry) => ran(entry) && !hasTestsThatRan.has(entry.item.extId)).map((entry) => toTest(entry, byId));
  return {
    id: result.id,
    completedAt: result.completedAt,
    hasCoverage: result.tasks.some((task) => task.hasCoverage === true),
    tests,
  };
}

class TestResultsReader {
  /** @param {() => string | undefined} storagePath this extension's workspace storage folder, if any */
  constructor(storagePath) {
    this.storagePath = storagePath;
  }

  /** The results folder, after checking that the extension's storage sits in VS Code's workspace storage. */
  async directory() {
    const own = this.storagePath();
    if (!own) {
      throw new Error(NO_STORAGE);
    }
    const workspaceDir = path.dirname(own);
    const marker = await fs.stat(path.join(workspaceDir, WORKSPACE_MARKER)).catch(() => undefined);
    if (!marker?.isFile()) {
      throw new Error(NOT_SUPPORTED);
    }
    return path.join(workspaceDir, RESULTS_DIR);
  }

  /** Ids of the stored results; cheap, the files are not read. */
  async ids() {
    const names = await fs.readdir(await this.directory()).catch(() => []);
    return new Set(names.map((name) => RESULT_FILE.exec(name)?.[1]).filter(Boolean));
  }

  /**
   * The stored results with the given ids (all when none are given), newest first. Files being written
   * (invalid JSON) and files of an unknown shape are skipped; when files exist but none is readable, the
   * storage format changed.
   */
  async read(ids) {
    const dir = await this.directory();
    const wanted = [...(ids ?? (await this.ids()))];
    let unknownShapes = 0;
    const results = await Promise.all(
      wanted.map(async (id) => {
        const text = await fs.readFile(path.join(dir, `${id}.json`), 'utf8').catch(() => undefined);
        let parsed;
        try {
          parsed = text === undefined ? undefined : JSON.parse(text);
        } catch {
          return undefined;
        }
        if (parsed !== undefined && !isKnownShape(parsed)) {
          unknownShapes += 1;
          return undefined;
        }
        return parsed && toResult(parsed);
      }),
    );
    const readable = results.filter(Boolean);
    if (unknownShapes && !readable.length) {
      throw new Error(NOT_SUPPORTED);
    }
    return readable.sort((a, b) => b.completedAt - a.completedAt);
  }

  /** The newest result, or undefined when none is stored. */
  async latest() {
    return (await this.read())[0];
  }

  /**
   * The result of the run started after `before` was taken (the stored ids at that moment), waiting for
   * VS Code to store it; undefined when none arrives, as when a run had nothing to run (no failed tests to
   * rerun). Only new files are read on each poll. Some test extensions (Jest) end an empty run at once and
   * report the tests in a second run, so an empty result waits a while for a newer one with tests.
   */
  async after(before) {
    let empty;
    const arrivalDeadline = Date.now() + ARRIVAL_TIMEOUT_MS;
    const deadline = () => (empty ? empty.seenAt + EMPTY_RUN_GRACE_MS : arrivalDeadline);
    while (Date.now() <= deadline()) {
      const fresh = [...(await this.ids())].filter((id) => !before.has(id));
      const newest = fresh.length ? (await this.read(fresh))[0] : undefined;
      if (newest?.tests.length) {
        return newest;
      }
      if (newest) {
        empty ??= { result: newest, seenAt: Date.now() };
      }
      await sleep(ARRIVAL_POLL_MS);
    }
    return empty?.result;
  }
}

module.exports = { TestResultsReader, ID_SEPARATOR, lastIdPart };
