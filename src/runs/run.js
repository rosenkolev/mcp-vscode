'use strict';

const vscode = require('vscode');

const MAX_BUFFERED_LINES = 20000;
const TRIM_SLACK_LINES = 1000;
// CSI sequences, OSC sequences (BEL or ST terminated) and two-character escapes.
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\x5c)|\x1b[@-Z\x5c-_]/g;
const ENDED_STATES = ['exited', 'terminated', 'failed'];

/** Keeps what a terminal would show for a line redrawn with carriage returns (progress bars). */
function lastSegment(line) {
  return line.split('\r').filter(Boolean).pop() ?? '';
}

/**
 * The unfinished line without the redraws before its last carriage return, so a spinner that never
 * prints a newline does not grow it; `lastSegment` of the result is unchanged.
 */
function redrawnTail(line) {
  // Trailing carriage returns stay: the next chunk may start with the \n of a \r\n.
  return line.slice(line.replace(/\r+$/, '').lastIndexOf('\r') + 1);
}

/**
 * One execution of a task or terminal command: its state, exit code and a bounded, ANSI-stripped
 * line buffer. Line indexes are absolute, so they stay valid after old lines are dropped.
 */
class Run {
  constructor(label) {
    this.label = label;
    /** @type {'starting' | 'running' | 'exited' | 'terminated' | 'failed'} */
    this.state = 'starting';
    /** @type {number | undefined} */
    this.exitCode = undefined;
    /** @type {number | undefined} */
    this.pid = undefined;
    this.startedAt = Date.now();
    /** @type {number | undefined} */
    this.endedAt = undefined;
    /** Why the output is not captured; undefined while it is. @type {string | undefined} */
    this.uncapturedReason = undefined;
    /** @type {string[]} */
    this.lines = [];
    this.droppedLines = 0;
    this.partialLine = '';
    this.changed = new vscode.EventEmitter();
  }

  get ended() {
    return ENDED_STATES.includes(this.state);
  }

  get captured() {
    return !this.uncapturedReason;
  }

  /** Absolute index one past the last complete line. */
  get lineCount() {
    return this.droppedLines + this.lines.length;
  }

  append(text) {
    const parts = (this.partialLine + text).replace(ANSI_PATTERN, '').split(/\r?\n/);
    this.partialLine = redrawnTail(parts.pop() ?? '');
    for (const part of parts) {
      this.lines.push(lastSegment(part));
    }
    // Trimmed in chunks, so the buffer is not shifted on every append once full.
    if (this.lines.length > MAX_BUFFERED_LINES + TRIM_SLACK_LINES) {
      const overflow = this.lines.length - MAX_BUFFERED_LINES;
      this.lines.splice(0, overflow);
      this.droppedLines += overflow;
    }
    this.changed.fire();
  }

  setRunning(pid) {
    this.pid ??= pid;
    if (this.state === 'starting') {
      this.state = 'running';
    }
    this.changed.fire();
  }

  finish(state, exitCode) {
    if (this.ended) {
      return;
    }
    if (this.partialLine) {
      this.lines.push(lastSegment(this.partialLine));
      this.partialLine = '';
    }
    this.state = state;
    this.exitCode = exitCode;
    this.endedAt = Date.now();
    this.changed.fire();
  }

  /**
   * Selects buffered lines, including the one still being written: from `since` forward, or the
   * tail; optionally only lines matching `filter`.
   * @returns {{ entries: [number, string][], truncated: boolean, nextSince: number, total: number }}
   */
  read({ since, maxLines, filter }) {
    const buffered = this.partialLine ? [...this.lines, lastSegment(this.partialLine)] : this.lines;
    // Lines before `since` are skipped up front, so a poll of a long run does not walk the whole buffer.
    const first = since === undefined ? 0 : Math.max(since - this.droppedLines, 0);
    /** @type {[number, string][]} */
    const candidates = buffered.slice(first).map((text, index) => [this.droppedLines + first + index, text]);
    const matching = filter ? candidates.filter(([, text]) => filter.test(text)) : candidates;
    const truncated = matching.length > maxLines;
    const entries = since === undefined ? matching.slice(-maxLines) : matching.slice(0, maxLines);
    const afterLast = entries.length ? entries[entries.length - 1][0] + 1 : (since ?? this.lineCount);
    return {
      entries,
      truncated,
      // The line still being written is shown but not consumed, so the next read returns it complete.
      nextSince: Math.min(afterLast, this.lineCount),
      total: this.droppedLines + buffered.length,
    };
  }

  /**
   * Resolves when the run ends, when `pattern` matches a line at or after `fromLine`, or on timeout.
   * @returns {Promise<{ reason: 'exit' | 'pattern' | 'timeout', line?: number }>}
   */
  waitFor({ pattern, fromLine = 0, timeoutMs }) {
    return new Promise((resolve) => {
      let next = fromLine;
      const finish = (result) => {
        clearTimeout(timer);
        subscription.dispose();
        resolve(result);
      };
      const check = () => {
        if (pattern) {
          for (let line = Math.max(next, this.droppedLines); line < this.lineCount; line++) {
            if (pattern.test(this.lines[line - this.droppedLines])) {
              return finish({ reason: 'pattern', line });
            }
          }
          next = this.lineCount;
          if (this.partialLine && pattern.test(lastSegment(this.partialLine))) {
            return finish({ reason: 'pattern', line: next });
          }
        }
        if (this.ended) {
          finish({ reason: 'exit' });
        }
      };
      const subscription = this.changed.event(check);
      const timer = setTimeout(() => finish({ reason: 'timeout' }), timeoutMs);
      check();
    });
  }

  dispose() {
    this.changed.dispose();
  }
}

module.exports = { Run };
