'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// Commands run through node, so they work in the default shell of any platform.
const PRINT_LINES = `node -e "console.log('hello'); for (let i = 1; i <= 5; i++) console.log('line ' + i)"`;

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('terminals', { timeout: 120000 }, () => {
    it('runs a command and returns its exit code and output', async () => {
      const text = await live.client.ok('run_in_terminal', { command: PRINT_LINES, terminal: 'T1', cwd: 'a' });
      assert.match(text, /exited \(exit code 0\)/);
      assert.match(text, /hello\nline 1\nline 2\nline 3\nline 4\nline 5/);
    });

    it('resolves a bare workspace folder name as the directory', async () => {
      const text = await live.client.ok('run_in_terminal', { command: `node -e "console.log(process.cwd())"`, terminal: 'T1', cwd: 'b' });
      assert.match(text, /[/\\]b\s*$/m);
    });

    it('reports a failing exit code', async () => {
      const text = await live.client.ok('run_in_terminal', { command: `node -e "process.exit(3)"`, terminal: 'T1' });
      assert.match(text, /exited \(exit code [13]\)/);
    });

    it('waits for an output pattern, then for the exit', async () => {
      const command = `node -e "setTimeout(() => console.log('READY'), 1500); setTimeout(() => console.log('done'), 2500)"`;
      const started = await live.client.ok('run_in_terminal', {
        command,
        terminal: 'T2',
        wait_for_exit: false,
        wait_for_pattern: 'ready',
        timeout_seconds: 30,
      });
      assert.match(started, /Wait: pattern matched on line 0/);
      const ended = await live.client.ok('read_terminal', { terminal: 'T2', wait_for_exit: true, timeout_seconds: 30 });
      assert.match(ended, /READY\ndone/);
    });

    it('reads earlier output from a line, filtered and limited', async () => {
      const filtered = await live.client.ok('read_terminal', { terminal: 'T1', command: 'line', since: 0, filter: 'line [24]' });
      assert.match(filtered, /filtered[\s\S]*2: line 2\n4: line 4/);
      const limited = await live.client.ok('read_terminal', { terminal: 'T1', command: 'line', since: 3, max_lines: 2 });
      assert.match(limited, /truncated to 2[\s\S]*line 3\nline 4/);
    });

    it('lists the terminals and clears one', async () => {
      assert.match(await live.client.ok('read_terminal'), /"T1"[\s\S]*"T2"/);
      assert.match(await live.client.ok('clear_terminal', { terminal: 'T1' }), /Cleared terminal "T1"/);
      assert.match(await live.client.fails('read_terminal', { terminal: 'T1' }), /No command captured/);
    });

    it('refuses a missing directory or terminal', async () => {
      assert.match(await live.client.fails('run_in_terminal', { command: 'echo x', cwd: 'a/missing' }), /No directory at/);
      assert.match(await live.client.fails('read_terminal', { terminal: 'Nope' }), /No terminal "Nope"/);
    });
  });
