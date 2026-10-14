'use strict';

/*
 * Multi-window live tests: one VS Code profile with the packaged extension installed, and three windows
 * of it open in one VS Code instance: a multi-root workspace, a single folder and a single file. Checks
 * that every agent works in its own window through the one main port, whether it runs inside a window
 * (placed by its process) or outside VS Code (placed by its MCP roots), and that another window takes
 * over the port when the serving window closes. Run with `npm run test:live:windows`.
 */

const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const { LiveProfile } = require('./harness/profile');
const { eventually } = require('./harness/poll');

const START_TIMEOUT_MS = 600000;
const TAKEOVER_TIMEOUT_MS = 15000;
const PROBE = path.join(__dirname, 'harness', 'probe.js');

const profile = new LiveProfile();
/** @type {Record<'workspace' | 'folder' | 'file', Awaited<ReturnType<LiveProfile['open']>>>} */
const windows = {};

/** What get_workspace says about each window, to tell which window answered. */
const ANSWERS = {
  workspace: /multi-root workspace/,
  folder: /single folder[\s\S]*Folders \(1\):\n\s+solo - /,
  file: /no folder open/,
};

let probes = 0;

/**
 * Runs the probe client in a terminal of `window`, as an agent started there would, and returns its
 * result. Each probe gets its own terminal and nonce, so an earlier probe's output cannot stand in.
 */
async function probeFrom(window, root) {
  const nonce = `p${++probes}`;
  const command = `node "${PROBE}" ${profile.port} get_workspace ${nonce}${root ? ` "${root}"` : ''}`;
  const output = await window.client.ok('run_in_terminal', { command, terminal: `probe ${nonce}`, timeout_seconds: 60 });
  // The terminal may put control characters before the line, so the tagged JSON is searched for anywhere.
  const json = new RegExp(`PROBE ${nonce} (\\{.*\\})`).exec(output)?.[1];
  assert.ok(json, `probe ${nonce} printed no result:\n${output}`);
  return JSON.parse(json);
}

/** Waits until every open window answers get_workspace as `expectation` says. */
async function everyWindow(expectation, what) {
  for (const window of profile.windows) {
    await eventually(async () => expectation(await window.client.call('get_workspace')), 15000, `${window.name} ${what}`);
  }
}

before(
  async () => {
    await profile.start();
    // A folder no other window has open; the workspace window has a and b.
    await fs.mkdir(profile.file('solo', 'sub'), { recursive: true });
    await fs.writeFile(profile.file('solo', 'readme.txt'), 'solo folder\n');
    windows.workspace = await profile.open(profile.file('test.code-workspace'));
    windows.folder = await profile.open(profile.file('solo'));
    windows.file = await profile.open(profile.file('a', 'notes.txt'));
  },
  { timeout: START_TIMEOUT_MS },
);
after(() => profile.stop(), { timeout: 120000 });

describe('several windows of one profile', { timeout: 300000 }, () => {
  it('registers each window once, in one VS Code instance, with one window on the main port', async () => {
    const entries = await profile.registry();
    assert.equal(entries.length, 3);
    assert.equal(entries.filter((entry) => entry.main).length, 1);
    assert.equal(new Set(entries.map((entry) => entry.port)).size, 3);
    assert.deepEqual(windows.folder.folders.map((folder) => folder.toLowerCase()), [profile.file('solo').toLowerCase()]);
    assert.deepEqual(windows.file.folders, []);
    assert.match(windows.file.name, /notes\.txt \(no folder\)/);
  });

  it("answers on each window's own port from that window", async () => {
    for (const [kind, window] of Object.entries(windows)) {
      assert.match(await window.client.ok('get_workspace'), ANSWERS[kind], kind);
    }
  });

  it('places an agent in a window terminal in that window, whatever its folder', async () => {
    for (const [kind, window] of Object.entries(windows)) {
      const result = await probeFrom(window);
      assert.ok(result.ok, `${kind}: ${result.text}`);
      assert.match(result.text, ANSWERS[kind], kind);
      assert.equal(result.rootsRequests, 0, `${kind} was placed by its process, not by roots`);
    }
    // The process decides even when the agent's folder belongs to another window.
    const result = await probeFrom(windows.file, profile.file('b'));
    assert.match(result.text, ANSWERS.file);
    assert.equal(result.rootsRequests, 0);
  });

  it('places an agent outside VS Code by its folder', async () => {
    const inFolder = profile.mainClient([profile.file('solo', 'sub')]);
    assert.match(await inFolder.ok('get_workspace'), ANSWERS.folder);
    assert.equal(inFolder.rootsRequests, 1);
    assert.match(await profile.mainClient([profile.file('b')]).ok('get_workspace'), ANSWERS.workspace);
  });

  it('refuses an agent outside VS Code whose folder no window or several windows have open', async () => {
    assert.match(await profile.mainClient([profile.file('elsewhere')]).fails('get_workspace'), /No VS Code window has/);
    // The whole fixture copy is open in no window, but contains the folders of two: a (workspace) and solo (folder).
    assert.match(await profile.mainClient([profile.fixture.workspaceDir]).fails('get_workspace'), /matches several VS Code windows/);
    assert.match(await profile.mainClient().fails('get_workspace'), /sent no folder/);
  });

  it('shares user settings across the windows of the profile', async () => {
    await profile.writeUserSettings({ 'mcpVscode.disabledTools': ['get_workspace'] });
    try {
      await everyWindow((reply) => /disabled by the user/.test(reply.text), 'to read the settings');
    } finally {
      await profile.writeUserSettings({});
      await everyWindow((reply) => reply.ok, 'to see the settings cleared');
    }
  });

  it('hands the main port to another window when the serving window closes', async () => {
    const main = await profile.main();
    const serving = Object.values(windows).find((window) => window.pid === main.pid);
    assert.ok(serving, `the main port is served by pid ${main?.pid}, which is none of the test windows`);
    await profile.close(serving);
    const next = await eventually(async () => {
      const candidate = await profile.main();
      return candidate && candidate.pid !== main.pid && candidate;
    }, TAKEOVER_TIMEOUT_MS, 'another window to serve the main port');
    assert.notEqual(next.pid, main.pid);
    const remaining = Object.entries(windows).filter(([, window]) => window !== serving);
    for (const [kind, window] of remaining) {
      const result = await probeFrom(window);
      assert.match(result.text, ANSWERS[kind], `${kind} after the takeover`);
    }
  });
});
