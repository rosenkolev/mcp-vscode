'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('tasks', { timeout: 120000 }, () => {
    it('lists the tasks of the workspace file', async () => {
      assert.match(await live.client.ok('list_tasks'), /^hello\nserver \(background\)/);
    });

    it('runs a task and captures its output', async () => {
      const text = await live.client.ok('run_task', { name: 'hello', wait_for_exit: true, timeout_seconds: 60 });
      assert.match(text, /hello: exited \(exit code 0\)[\s\S]*hello task/);
    });

    it('waits for a background task to be ready, refuses a second start, restarts', async () => {
      assert.match(await live.client.ok('run_task', { name: 'server', wait_for_pattern: 'READY', timeout_seconds: 30 }), /pattern matched/);
      assert.match(await live.client.fails('run_task', { name: 'server' }), /already running/);
      assert.match(
        await live.client.ok('run_task', { name: 'server', restart: true, wait_for_pattern: 'READY', timeout_seconds: 30 }),
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
