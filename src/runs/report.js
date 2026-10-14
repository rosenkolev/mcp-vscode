'use strict';

const { timeoutProperty } = require('../shared/schema');

/** Input-schema properties shared by the tools that return run output. */
const sinceProperty = {
  type: 'integer',
  minimum: 0,
  description:
    'Return output from this line index on (the "Next since" of the previous read). Without it, the last max_lines lines are returned. Also where wait_for_pattern starts searching; without it, only lines printed after the call are searched.',
};
function waitProperties(waitForExitByDefault) {
  return {
    wait_for_exit: {
      type: 'boolean',
      default: waitForExitByDefault,
      description: 'Block until the run ends (or the timeout passes), then return its status and output.',
    },
    wait_for_pattern: {
      type: 'string',
      format: 'regex',
      description:
        'Case-insensitive regex. Block until an output line matches (e.g. "ready in|compiled successfully"), the run ends, or the timeout passes. Use for watchers and dev servers.',
    },
    timeout_seconds: timeoutProperty(120, 'The run keeps going after a timeout.'),
  };
}

function formatDuration(milliseconds) {
  const seconds = milliseconds / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function describeRun(run) {
  const folder = run.folderName ? ` [${run.folderName}]` : '';
  const exitCode = run.exitCode !== undefined ? ` (exit code ${run.exitCode})` : '';
  const pid = run.pid !== undefined && !run.ended ? `, pid ${run.pid}` : '';
  const duration = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
  return `${run.label}${folder}: ${run.state}${exitCode}${pid}, ${duration}`;
}

/** Waits as the wait_* arguments ask, searching for a pattern from `fromLine` on. Returns report notes. */
async function waitAsRequested(run, { wait_for_exit, wait_for_pattern, timeout_seconds }, fromLine) {
  if (!wait_for_exit && !wait_for_pattern) {
    return [];
  }
  const pattern = run.captured ? wait_for_pattern : undefined;
  const notes =
    wait_for_pattern && !pattern
      ? ['Output is not captured, so wait_for_pattern was ignored and the wait is for exit only.']
      : [];
  const wait = await run.waitFor({ pattern, fromLine, timeoutMs: timeout_seconds * 1000 });
  const outcomes = {
    pattern: `pattern matched on line ${wait.line}.`,
    exit: 'run ended.',
    timeout: `timed out after ${timeout_seconds}s; run is still ${run.state}.`,
  };
  return [...notes, `Wait: ${outcomes[wait.reason]}`];
}

/** Status line, notes and the output selected by the since / max_lines / filter arguments. */
function report(run, { since, max_lines, filter }, notes) {
  const lines = [describeRun(run), ...notes];
  if (!run.captured) {
    lines.push(
      `Output not captured: ${run.uncapturedReason}. It is only in the VS Code terminal; problem-matcher errors are readable with get_diagnostics.`,
    );
    return lines.join('\n');
  }
  const { entries, truncated, nextSince, total, dropped } = run.read({ since, maxLines: max_lines, filter });
  if (dropped) {
    lines.push(`Lines before ${dropped} were dropped from the buffer and are only in the terminal.`);
  }
  if (entries.length) {
    const range = `lines ${entries[0][0]}-${entries[entries.length - 1][0]} of ${total}`;
    const qualifiers = `${truncated ? `, truncated to ${max_lines}` : ''}${filter ? ', filtered' : ''}`;
    lines.push(`Output ${range}${qualifiers}. Next since: ${nextSince}.`);
  } else {
    lines.push(`No ${filter ? 'matching' : 'new'} output (${total} lines total). Next since: ${nextSince}.`);
  }
  lines.push('---', ...entries.map(([index, text]) => (filter ? `${index}: ${text}` : text)));
  return lines.join('\n');
}

/**
 * Waits as the wait_* arguments ask, then reports. The wait searches for a pattern from `fromLine` on,
 * which defaults to `since`, else to the lines printed after the call. `notesOf(run)` adds notes that
 * depend on the state after the wait.
 */
async function waitAndReport(run, args, fromLine = args.since ?? run.lineCount, notesOf = () => []) {
  const notes = await waitAsRequested(run, args, fromLine);
  return report(run, args, [...notes, ...notesOf(run)]);
}

module.exports = { sinceProperty, waitProperties, describeRun, waitAndReport };
