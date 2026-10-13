'use strict';

const vscode = require('vscode');

/**
 * Which threads are paused, per debug session, read from the debug adapters' own "stopped" and
 * "continued" events. `vscode.debug.activeStackItem` cannot tell: a pause in runtime internals focuses
 * the thread instead of a frame, and the focus does not change when the same thread pauses again.
 */
class DebugState {
  constructor() {
    /** Paused thread ids per session. @type {Map<vscode.DebugSession, Set<number>>} */
    this.pausedThreads = new Map();
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
      vscode.debug.onDidTerminateDebugSession((session) => this.pausedThreads.delete(session)),
    ];
  }

  handleEvent(session, { event, body = {} }) {
    const paused = this.pausedThreads.get(session) ?? new Set();
    if (event === 'stopped' && body.threadId !== undefined) {
      paused.add(body.threadId);
      this.pausedThreads.set(session, paused);
      this.stoppedEmitter.fire({ session, threadId: body.threadId });
    } else if (event === 'continued') {
      if (body.allThreadsContinued === false) {
        paused.delete(body.threadId);
      } else {
        paused.clear();
      }
    }
  }

  /** `{ session, threadId }` of a paused thread of `session`, preferring the one in focus. */
  pausedThread(session = vscode.debug.activeDebugSession) {
    const paused = session && this.pausedThreads.get(session);
    if (!paused?.size) {
      return undefined;
    }
    const focused = vscode.debug.activeStackItem;
    const threadId = focused?.session === session && paused.has(focused.threadId) ? focused.threadId : [...paused][0];
    return { session, threadId };
  }

  dispose() {
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { DebugState };
