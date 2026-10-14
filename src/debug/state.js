'use strict';

const vscode = require('vscode');
const { Run } = require('../runs/run');

/** Output categories that are not program or Debug Console output. */
const IGNORED_OUTPUT_CATEGORIES = ['telemetry'];
const MAX_KEPT_OUTPUTS = 5;
/** Stands in for a thread id when an adapter reports a stop of every thread without naming one. */
const ALL_THREADS = -1;

/** The session a child session (such as the one js-debug starts per Node process) belongs to. */
function rootOf(session) {
  let root = session;
  while (root.parentSession) {
    root = root.parentSession;
  }
  return root;
}

/**
 * Which threads are paused, per debug session, read from the debug adapters' own "stopped" and
 * "continued" events. `vscode.debug.activeStackItem` cannot tell: a pause in runtime internals focuses
 * the thread instead of a frame, and the focus does not change when the same thread pauses again.
 * Also keeps the Debug Console output of each root session as a Run.
 */
class DebugState {
  constructor() {
    /** Body of the "stopped" event per paused thread id, per session. @type {Map<vscode.DebugSession, Map<number, object>>} */
    this.pausedThreads = new Map();
    /** Debug Console output per root session, oldest first. @type {Map<vscode.DebugSession, Run>} */
    this.outputs = new Map();
    this.stoppedEmitter = new vscode.EventEmitter();
    /** Fires `{ session, threadId }` whenever a thread pauses: breakpoint, step, pause or exception. */
    this.onDidStop = this.stoppedEmitter.event;
    this.disposables = [
      this.stoppedEmitter,
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => message.type === 'event' && this.handleEvent(session, message),
          // A stopping session answers no more requests, so its threads no longer count as paused.
          onWillStopSession: () => this.pausedThreads.delete(session),
          onExit: () => this.pausedThreads.delete(session),
        }),
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.pausedThreads.delete(session);
        if (!session.parentSession) {
          this.outputs.get(session)?.finish('exited');
        }
      }),
    ];
  }

  handleEvent(session, { event, body = {} }) {
    if (event === 'output') {
      if (!IGNORED_OUTPUT_CATEGORIES.includes(body.category) && body.output) {
        this.outputOf(rootOf(session)).append(body.output);
      }
      return;
    }
    if (event !== 'stopped' && event !== 'continued') {
      return;
    }
    const paused = this.pausedThreads.get(session) ?? new Map();
    if (event === 'stopped') {
      // Without a thread id, every thread stopped; the focused thread, or any, stands for them.
      const threadId = body.threadId ?? vscode.debug.activeStackItem?.threadId ?? ALL_THREADS;
      paused.set(threadId, body);
      this.pausedThreads.set(session, paused);
      this.stoppedEmitter.fire({ session, threadId });
    } else if (body.allThreadsContinued === false) {
      paused.delete(body.threadId);
    } else {
      paused.clear();
    }
  }

  /** Output run of a root session, created on its first output; only the latest few sessions are kept. */
  outputOf(root) {
    let run = this.outputs.get(root);
    if (!run) {
      run = new Run(`Debug Console of "${root.name}"`);
      run.setRunning();
      this.outputs.set(root, run);
      const ended = [...this.outputs].filter(([, candidate]) => candidate.ended);
      ended.slice(0, Math.max(this.outputs.size - MAX_KEPT_OUTPUTS, 0)).forEach(([key, candidate]) => {
        candidate.dispose();
        this.outputs.delete(key);
      });
    }
    return run;
  }

  /** Output of the active session's root, else of the latest session that had output. */
  latestOutput() {
    const active = vscode.debug.activeDebugSession;
    return (active && this.outputs.get(rootOf(active))) ?? [...this.outputs.values()].at(-1);
  }

  /** `{ session, threadId, stop }` of a paused thread of `session`, preferring the one in focus; `stop` is its "stopped" event body. */
  pausedThread(session = vscode.debug.activeDebugSession) {
    const paused = session && this.pausedThreads.get(session);
    if (!paused?.size) {
      return undefined;
    }
    const focused = vscode.debug.activeStackItem;
    const threadId = focused?.session === session && paused.has(focused.threadId) ? focused.threadId : [...paused.keys()][0];
    return { session, threadId, stop: paused.get(threadId) };
  }

  dispose() {
    this.outputs.forEach((run) => run.dispose());
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { DebugState };
