'use strict';

const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');
const { eventually, sleep } = require('../harness/poll');

// Commands run through node, so they work in the default shell of any platform.
const PRINT_LINES = `node -e "console.log('hello'); for (let i = 1; i <= 5; i++) console.log('line ' + i)"`;
const CLOSE_TIMEOUT_MS = 10000;
const SETTINGS_RELOAD_MS = 3000;

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('terminals', { timeout: 120000 }, () => {
    after(async () => {
      // A failed test may leave a command running; closing the terminals ends it.
      for (const terminal of ['T1', 'T2', 'T3', 'T4', 'T5']) {
        await live.client.call('close_terminal', { terminal });
      }
    });

    it('runs a command and returns its exit code and output', async () => {
      const text = await live.client.ok('run_in_terminal', { command: PRINT_LINES, terminal: 'T1', cwd: 'a', keep_open: true });
      assert.match(text, /exited \(exit code 0\)/);
      assert.match(text, /hello\nline 1\nline 2\nline 3\nline 4\nline 5/);
    });

    it('starts terminals without a git pager', async () => {
      const text = await live.client.ok('run_in_terminal', { command: `node -e "console.log('pager=' + process.env.GIT_PAGER)"`, terminal: 'T1' });
      assert.match(text, /pager=cat/);
    });

    it('resolves a bare workspace folder name as the directory', async () => {
      const command = `node -e "console.log(process.cwd())"`;
      const text = await live.client.ok('run_in_terminal', { command, terminal: 'T1', cwd: 'b', keep_open: true });
      assert.match(text, /[/\\]b\s*$/m);
    });

    it('reports a failing exit code', async () => {
      const text = await live.client.ok('run_in_terminal', { command: `node -e "process.exit(3)"`, terminal: 'T1', keep_open: true });
      // PowerShell's shell integration reports every failure as 1; other shells report the real code.
      assert.match(text, /exited \(exit code (3|1)\)/);
      if (/exit code 1\)/.test(text)) {
        assert.match(text, /PowerShell reports every failed command as exit code 1/);
      }
    });

    it('closes the terminal once the command ends, keeping its output readable', async () => {
      await live.client.ok('run_in_terminal', { command: `node -e "console.log('closing')"`, terminal: 'T3', close_delay_seconds: 3 });
      // It stays open for the delay, so the user can see the result, then closes.
      assert.match(await live.client.ok('read_terminal'), /"T3" \([^)]*\) - closing/);
      await eventually(async () => !/"T3"/.test(await live.client.ok('read_terminal')), CLOSE_TIMEOUT_MS, 'terminal T3 to close');
      assert.match(await live.client.ok('read_terminal', { terminal: 'T3' }), /closing/);
      // The name is free again at once, even while VS Code is still closing the old terminal.
      assert.match(await live.client.ok('run_in_terminal', { command: `node -e "console.log('again')"`, terminal: 'T3' }), /again/);
    });

    it('answers a prompt, interrupts a command and closes the terminal', async () => {
      const prompt = `node -e "process.stdout.write('Continue? '); process.stdin.once('data', (d) => { console.log('got ' + d.toString().trim()); process.exit(0); })"`;
      const asked = await live.client.ok('run_in_terminal', { command: prompt, terminal: 'T4', keep_open: true, wait_for_pattern: 'Continue', wait_for_exit: false, timeout_seconds: 30 });
      assert.match(asked, /pattern matched/);
      assert.match(await live.client.ok('send_to_terminal', { terminal: 'T4', text: 'y', wait_for_exit: true, timeout_seconds: 30 }), /Sent "y" \+ Enter[\s\S]*got y/);

      const forever = `node -e "setInterval(() => {}, 1000); console.log('waiting')"`;
      await live.client.ok('run_in_terminal', { command: forever, terminal: 'T4', keep_open: true, wait_for_pattern: 'waiting', wait_for_exit: false, timeout_seconds: 30 });
      assert.match(await live.client.fails('run_in_terminal', { command: 'echo x', terminal: 'T4' }), /is still running/);
      assert.match(await live.client.ok('send_to_terminal', { terminal: 'T4', interrupt: true, wait_for_exit: true, timeout_seconds: 30 }), /Sent Ctrl\+C[\s\S]*exited/);
      // Ctrl+C with a new command: the command waits for the prompt, then runs as a captured command.
      await live.client.ok('run_in_terminal', { command: forever, terminal: 'T4', keep_open: true, wait_for_pattern: 'waiting', wait_for_exit: false, timeout_seconds: 30 });
      const next = await live.client.ok('send_to_terminal', { terminal: 'T4', interrupt: true, text: `node -e "console.log('next')"`, wait_for_exit: true, timeout_seconds: 30 });
      assert.match(next, /Sent Ctrl\+C, then[\s\S]*console\.log\('next'\)\)?"?: exited \(exit code 0\)[\s\S]*\nnext/);

      assert.match(await live.client.ok('close_terminal', { terminal: 'T4' }), /Closed terminal "T4"/);
      assert.match(await live.client.fails('send_to_terminal', { terminal: 'T4', text: 'x' }), /No terminal "T4"/);
      assert.match(await live.client.ok('read_terminal', { terminal: 'T4' }), /exited/);
    });

    it('waits for an output pattern, then for the exit', async () => {
      const command = `node -e "setTimeout(() => console.log('READY'), 1500); setTimeout(() => console.log('done'), 2500)"`;
      const started = await live.client.ok('run_in_terminal', {
        command,
        terminal: 'T2',
        keep_open: true,
        wait_for_exit: false,
        wait_for_pattern: 'ready',
        timeout_seconds: 30,
      });
      assert.match(started, /Wait: pattern matched on line 0: READY/);
      const ended = await live.client.ok('read_terminal', { terminal: 'T2', wait_for_exit: true, timeout_seconds: 30 });
      assert.match(ended, /READY\ndone/);
    });

    it('reads earlier output from a line, filtered and limited', async () => {
      await live.client.ok('run_in_terminal', { command: PRINT_LINES, terminal: 'T5', keep_open: true });
      const filtered = await live.client.ok('read_terminal', { terminal: 'T5', command: 'line', since: 0, filter: 'line [24]' });
      assert.match(filtered, /filtered[\s\S]*2: line 2\n4: line 4/);
      const limited = await live.client.ok('read_terminal', { terminal: 'T5', command: 'line', since: 3, max_lines: 2 });
      assert.match(limited, /truncated to 2[\s\S]*line 3\nline 4/);
    });

    it('lists the terminals and clears one', async () => {
      assert.match(await live.client.ok('read_terminal'), /"T1"[\s\S]*"T2"/);
      assert.match(await live.client.ok('clear_terminal', { terminal: 'T1' }), /Cleared terminal "T1"/);
      assert.match(await live.client.fails('read_terminal', { terminal: 'T1' }), /No command captured/);
    });

    it('stops waiting at mcpVscode.maxWaitSeconds and says to call again', async () => {
      await live.writeUserSettings({ 'mcpVscode.maxWaitSeconds': 5 });
      // VS Code reads the changed settings file a moment later.
      await sleep(SETTINGS_RELOAD_MS);
      try {
        const sleep = `node -e "setTimeout(() => console.log('woke'), 9000)"`;
        const text = await live.client.ok('run_in_terminal', { command: sleep, terminal: 'T5', keep_open: true, timeout_seconds: 60 });
        assert.match(text, /timed out after 5s[\s\S]*Stopped waiting at 5s[\s\S]*Call again/);
        assert.match(await live.client.ok('read_terminal', { terminal: 'T5', wait_for_exit: true, timeout_seconds: 30 }), /woke/);
      } finally {
        await live.writeUserSettings({});
      }
    });

    it('refuses a missing directory or terminal', async () => {
      assert.match(await live.client.fails('run_in_terminal', { command: 'echo x', cwd: 'a/missing' }), /No directory at/);
      assert.match(await live.client.fails('read_terminal', { terminal: 'Nope' }), /No terminal "Nope"/);
    });
  });
