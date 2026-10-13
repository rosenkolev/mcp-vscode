'use strict';

const vscode = require('vscode');
const { singleLine } = require('../shared/text');
const { relativePath } = require('../workspace/paths');

const MAX_FRAMES = 20;
const MAX_VALUE_CHARS = 300;

/** @typedef {import('./state').DebugState} DebugState */

/** One line on the session: its name, type, and whether a thread is paused. */
function describeSession(state, session = vscode.debug.activeDebugSession) {
  if (!session) {
    return 'No debug session is running.';
  }
  return `Debugging "${session.name}" (${session.type}): ${state.pausedThread(session) ? 'paused' : 'running'}.`;
}

/**
 * The paused thread of `session` with its call stack and the frame to inspect: the one selected in the
 * Call Stack view when it belongs to that thread, else the top frame.
 */
async function pausedFrame(state, session) {
  const paused = state.pausedThread(session);
  if (!paused) {
    return undefined;
  }
  const { stackFrames } = await paused.session.customRequest('stackTrace', { threadId: paused.threadId, levels: MAX_FRAMES });
  const selected = vscode.debug.activeStackItem;
  const isSelectedHere =
    selected instanceof vscode.DebugStackFrame && selected.session === paused.session && selected.threadId === paused.threadId;
  return { ...paused, stackFrames, frameId: isSelectedHere ? selected.frameId : stackFrames[0]?.id };
}

function frameLine({ name, source, line }) {
  const location = source?.path ? `${relativePath(source.path)}:${line}` : source?.name ?? 'unknown source';
  return `${name} - ${location}`;
}

/** Runtime and library frames the debugger de-emphasizes in the Call Stack view, e.g. Node internals. */
const isInternalFrame = (frame) => frame.presentationHint === 'subtle' || frame.source?.presentationHint === 'deemphasize';

/** Call stack lines without internal frames, except the paused one, plus how many were left out. */
function stackLines(stackFrames) {
  const shown = stackFrames.filter((frame, index) => index === 0 || !isInternalFrame(frame));
  const hidden = stackFrames.length - shown.length;
  return ['Call stack:', ...shown.map((frame) => `  ${frameLine(frame)}`), ...(hidden ? [`  (${hidden} internal frames hidden)`] : [])];
}

/** One line, cut to a readable length; debuggers print objects and functions over several lines. */
function valueText(value) {
  const line = singleLine(value);
  return line.length > MAX_VALUE_CHARS ? `${line.slice(0, MAX_VALUE_CHARS)}...` : line;
}

/** Variables of the frame's non-expensive scopes (usually Locals), as "name = value" lines. */
async function scopeLines(session, frameId, maxVariables) {
  const { scopes } = await session.customRequest('scopes', { frameId });
  const cheap = scopes.filter((scope) => !scope.expensive);
  const groups = await Promise.all(
    cheap.map(async (scope) => {
      const { variables } = await session.customRequest('variables', { variablesReference: scope.variablesReference });
      return [`${scope.name}:`, ...variables.slice(0, maxVariables).map((variable) => `  ${variable.name} = ${valueText(variable.value)}`)];
    }),
  );
  return groups.flat();
}

async function evaluate(session, frameId, expression) {
  try {
    const { result } = await session.customRequest('evaluate', { expression, frameId, context: 'repl' });
    return `${expression} = ${valueText(result)}`;
  } catch (error) {
    return `${expression}: ${error.message}`;
  }
}

/**
 * Session state; when paused, the call stack and variables of the inspected frame; plus an evaluated
 * expression. `session` defaults to the active one.
 * @param {DebugState} state
 */
async function inspectDebugger(state, { expression, max_variables }, session = vscode.debug.activeDebugSession) {
  const lines = [describeSession(state, session)];
  if (!session) {
    return lines.join('\n');
  }
  const frame = await pausedFrame(state, session);
  if (frame) {
    lines.push(...stackLines(frame.stackFrames));
    if (max_variables > 0 && frame.frameId !== undefined) {
      lines.push(...(await scopeLines(session, frame.frameId, max_variables)));
    }
  }
  if (expression) {
    lines.push(await evaluate(session, frame?.frameId, expression));
  }
  return lines.join('\n');
}

module.exports = { describeSession, inspectDebugger };
