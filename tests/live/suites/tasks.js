'use strict';

const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');
const { eventually } = require('../harness/poll');

const TERMINAL_CLOSE_TIMEOUT_MS = 10000;

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('tasks', { timeout: 120000 }, () => {
    after(async () => {
      // A failed test may leave the background task running, which later runs would refuse to start.
      await live.client.call('close_task', { name: 'server' });
      await live.client.call('close_task', { name: 'ask' });
    });

    it('lists the tasks of the workspace file', async () => {
      assert.match(await live.client.ok('list_tasks'), /^ask\nhello\nserver \(background\)/);
    });

    it('runs a task and captures its output, then closes its terminal', async () => {
      const text = await live.client.ok('run_task', { name: 'hello', wait_for_exit: true, timeout_seconds: 60 });
      assert.match(text, /hello: exited \(exit code 0\)[\s\S]*hello task/);
      await eventually(
        async () => /No open terminal of this task/.test(await live.client.ok('close_task', { name: 'hello' })),
        TERMINAL_CLOSE_TIMEOUT_MS,
        'the terminal of hello to close',
      );
    });

    it('passes input typed into the task terminal to the task', async () => {
      assert.match(await live.client.ok('run_task', { name: 'ask', keep_open: true, wait_for_pattern: 'ASK', timeout_seconds: 30 }), /pattern matched/);
      const terminal = (await live.client.ok('read_terminal')).match(/"([^"]*ask[^"]*)"/)?.[1];
      assert.ok(terminal, 'the task terminal is listed');
      await live.client.ok('send_to_terminal', { terminal, text: 'yes' });
      assert.match(await live.client.ok('task_status', { name: 'ask', wait_for_exit: true, since: 0, timeout_seconds: 30 }), /exited \(exit code 0\)[\s\S]*task got yes/);
      await live.client.ok('close_task', { name: 'ask' });
    });

    it('waits for a background task to be ready, refuses a second start, restarts', async () => {
      assert.match(await live.client.ok('run_task', { name: 'server', wait_for_pattern: 'READY', timeout_seconds: 30 }), /pattern matched/);
      assert.match(await live.client.fails('run_task', { name: 'server' }), /already running/);
      assert.match(
        await live.client.ok('run_task', {
          name: 'server',
          restart: true,
          keep_open: true,
          wait_for_pattern: 'READY',
          timeout_seconds: 30,
        }),
        /running[\s\S]*READY/,
      );
      assert.match(await live.client.ok('task_status'), /server: running/);
    });

    it('stops a task and closes its terminal', async () => {
      const text = await live.client.ok('close_task', { name: 'server' });
      assert.match(text, /server: terminated/);
      assert.match(text, /Terminal closed/);
    });

    it('runs a task natively without capture', async () => {
      const text = await live.client.ok('run_task', { name: 'hello', capture: false, wait_for_exit: true, timeout_seconds: 60 });
      assert.match(text, /Output not captured: capture: false was requested/);
    });

    it('suggests similar task names with their folder', async () => {
      assert.match(await live.client.fails('run_task', { name: 'hel' }), /Similar: hello \[workspace\]/);
      assert.match(await live.client.fails('task_status', { name: 'nope' }), /No run of "nope" is tracked/);
    });
  });
