'use strict';

const vscode = require('vscode');

/**
 * Which exceptions the debugger pauses on, set by an agent. VS Code has no API for the exception
 * filters of the Breakpoints view, so they are sent to each debug adapter directly, right after VS Code
 * sends its own (a session sends them once while it starts), and to the running sessions when changed.
 * The Breakpoints view does not show them.
 */
class ExceptionBreakpoints {
  constructor() {
    /** Filter ids to apply, or undefined to leave each session as the Breakpoints view says. @type {string[] | undefined} */
    this.filters = undefined;
    /** Running sessions with the filters their adapter offers. @type {Map<vscode.DebugSession, { offered: object[], ownRequests: number }>} */
    this.sessions = new Map();
    this.disposables = [
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => {
          this.sessions.set(session, { offered: [], ownRequests: 0 });
          return {
            onDidSendMessage: (message) => message.type === 'response' && this.handleResponse(session, message),
            onExit: () => this.sessions.delete(session),
          };
        },
      }),
      vscode.debug.onDidTerminateDebugSession((session) => this.sessions.delete(session)),
    ];
  }

  handleResponse(session, { command, body }) {
    const state = this.sessions.get(session);
    if (!state) {
      return;
    }
    if (command === 'initialize') {
      state.offered = body?.exceptionBreakpointFilters ?? [];
    } else if (command === 'setExceptionBreakpoints') {
      if (state.ownRequests > 0) {
        state.ownRequests -= 1;
      } else {
        // VS Code just sent the Breakpoints view's filters; these replace them.
        this.apply(session);
      }
    }
  }

  apply(session) {
    const state = this.sessions.get(session);
    if (!state || !this.filters) {
      return;
    }
    state.ownRequests += 1;
    session.customRequest('setExceptionBreakpoints', { filters: this.filters }).catch(() => {
      state.ownRequests -= 1;
    });
  }

  /** Sets the filters for the running sessions and those started later; an empty list stops pausing on exceptions. */
  set(filters) {
    const offered = new Set([...this.sessions.values()].flatMap((state) => state.offered.map((filter) => filter.filter)));
    const unknown = filters.filter((filter) => offered.size && !offered.has(filter));
    if (unknown.length) {
      throw new Error(`The running debugger offers no exception filter ${unknown.map((f) => `"${f}"`).join(', ')}. ${this.describe()}`);
    }
    this.filters = filters;
    this.sessions.forEach((_, session) => this.apply(session));
    return filters.length ? `Pausing on exceptions: ${filters.join(', ')}.` : 'Not pausing on exceptions.';
  }

  /** The chosen filters and those the running debuggers offer. */
  describe() {
    const offered = [...this.sessions.values()].flatMap((state) => state.offered);
    const unique = [...new Map(offered.map((filter) => [filter.filter, filter])).values()];
    const chosen = this.filters ? this.filters.join(', ') || 'none' : 'as the Breakpoints view says';
    const available = unique.length
      ? unique.map((filter) => `${filter.filter} (${filter.label})`).join(', ')
      : 'known once a session runs; Node offers "uncaught" and "all"';
    return `Exception filters: ${chosen}. Offered: ${available}.`;
  }

  dispose() {
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}

module.exports = { ExceptionBreakpoints };
