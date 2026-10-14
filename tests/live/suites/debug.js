'use strict';

const assert = require('node:assert/strict');
const { describe, it, after } = require('node:test');

/** @param {import('../harness/vscode').LiveVsCode} live */
module.exports = (live) =>
  describe('debugging', { timeout: 180000 }, () => {
    after(async () => {
      await live.client.call('stop_debugging');
      await live.client.call('breakpoints', { action: 'remove' });
    });

    it('lists workspace-file and folder launch configurations once each', async () => {
      const text = await live.client.ok('list_debug_configs');
      assert.equal(
        text,
        [
          'Workspace Debug (node, launch) [workspace]',
          'Throws (node, launch) [workspace]',
          'Both (compound: Workspace Debug, Folder B [b]) [workspace]',
          'Broken (compound: Missing) [workspace]',
          'Folder B (node, launch) [b]',
        ].join('\n'),
      );
    });

    it('manages breakpoints', async () => {
      assert.match(await live.client.fails('breakpoints', { action: 'add', path: 'a/calc.js' }), /"add" needs "path" and "line"/);
      assert.match(await live.client.ok('breakpoints', { action: 'add', path: 'a/calc.js', line: 8 }), /Added a breakpoint at a\/calc\.js:8/);
      assert.match(await live.client.ok('breakpoints'), /^a\/calc\.js:8\nException filters:/);
    });

    it('starts a workspace-file configuration and stops at the breakpoint', async () => {
      const text = await live.client.ok('start_debugging', { name: 'Workspace Debug', wait_for_pause: true, timeout_seconds: 60 });
      assert.match(text, /paused\.\nCall stack:\n\s+total - a\/calc\.js:8/);
    });

    it('shows variables and evaluates an expression in the paused frame', async () => {
      const text = await live.client.ok('debug_inspect', { expression: 'items.length * 10', max_variables: 5 });
      assert.match(text, /items = \(3\) \[1, 2, 3\]/);
      assert.match(text, /items\.length \* 10 = 30/);
    });

    it('steps over and out', async () => {
      assert.match(await live.client.ok('debug_control', { action: 'step_over', timeout_seconds: 20 }), /total - a\/calc\.js:9/);
      assert.match(await live.client.ok('debug_control', { action: 'step_out', timeout_seconds: 20 }), /<anonymous> - a\/main\.js:4/);
    });

    it('reads what the program printed', async () => {
      await live.client.ok('debug_control', { action: 'step_over', timeout_seconds: 20 });
      assert.match(await live.client.ok('debug_output', { since: 0, filter: 'total' }), /total 6/);
    });

    it('continues, then pauses a running program', async () => {
      await live.client.ok('breakpoints', { action: 'remove', path: 'a/calc.js' });
      assert.match(await live.client.ok('debug_control', { action: 'continue', timeout_seconds: 3 }), /running\. Not paused within 3s/);
      assert.match(await live.client.ok('debug_control', { action: 'pause', timeout_seconds: 10 }), /paused\.\nCall stack:/);
      assert.match(await live.client.ok('debug_control', { action: 'pause', timeout_seconds: 3 }), /: paused\.$/);
    });

    it('stops debugging', async () => {
      assert.match(await live.client.ok('stop_debugging'), /Stopped debugging/);
      assert.match(await live.client.ok('debug_inspect'), /No debug session is running/);
      assert.match(await live.client.fails('debug_control', { action: 'continue' }), /No debug session is running/);
    });

    it('starts a compound of the workspace file and a folder configuration', async () => {
      assert.match(await live.client.ok('start_debugging', { name: 'Both' }), /Debugging/);
      // stop_debugging returns once no session is active, so the next start cannot see the old sessions.
      assert.match(await live.client.ok('stop_debugging'), /Stopped debugging/);
      assert.match(await live.client.ok('start_debugging', { name: 'Folder B' }), /Debugging "Folder B"/);
      assert.match(await live.client.ok('stop_debugging'), /Stopped debugging/);
    });

    it('logs through a logpoint and pauses on a conditional breakpoint', async () => {
      assert.match(
        await live.client.ok('breakpoints', { action: 'add', path: 'a/calc.js', line: 10, log_message: 'sum is {sum}' }),
        /Added a breakpoint at a\/calc\.js:10/,
      );
      await live.client.ok('breakpoints', { action: 'add', path: 'a/calc.js', line: 12, condition: 'sum === 6' });
      assert.match(await live.client.ok('breakpoints'), /a\/calc\.js:10, logs "sum is \{sum\}"\na\/calc\.js:12, if sum === 6/);
      try {
        const paused = await live.client.ok('start_debugging', { name: 'Workspace Debug', wait_for_pause: true, timeout_seconds: 60 });
        assert.match(paused, /paused\.\nCall stack:\n\s+total - a\/calc\.js:12/);
        assert.match(await live.client.ok('debug_inspect', { expression: 'sum' }), /sum = 6/);
        assert.match(await live.client.ok('debug_output', { since: 0, filter: 'sum is' }), /sum is 0\n[\s\S]*sum is 1\n[\s\S]*sum is 3/);
      } finally {
        await live.client.call('stop_debugging');
        await live.client.call('breakpoints', { action: 'remove', path: 'a/calc.js' });
      }
    });

    it('pauses on an uncaught exception on request and shows it', async () => {
      assert.match(await live.client.ok('breakpoints', { action: 'exceptions' }), /Exception filters: as the Breakpoints view says/);
      assert.match(await live.client.ok('breakpoints', { action: 'exceptions', exceptions: ['uncaught'] }), /Pausing on exceptions: uncaught/);
      try {
        const paused = await live.client.ok('start_debugging', { name: 'Throws', wait_for_pause: true, timeout_seconds: 60 });
        assert.match(paused, /parse - a\/throws\.js:5/);
        assert.match(await live.client.ok('debug_inspect'), /Paused on exception: TypeError: nothing to parse/);
        assert.match(await live.client.ok('breakpoints', { action: 'exceptions' }), /Offered: .*uncaught/);
        assert.match(await live.client.ok('debug_output', { since: 0, filter: 'before' }), /before the throw/);
      } finally {
        await live.client.call('breakpoints', { action: 'exceptions', exceptions: [] });
        await live.client.call('stop_debugging');
      }
    });

    it('reports broken and unknown configurations', async () => {
      assert.match(await live.client.fails('start_debugging', { name: 'Broken' }), /refers to "Missing"/);
      assert.match(await live.client.fails('start_debugging', { name: 'nope' }), /No launch configuration "nope"/);
      assert.match(await live.client.fails('start_debugging', { name: 'Folder B', folder: 'nofolder' }), /No workspace folder "nofolder"/);
    });
  });
