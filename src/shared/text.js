'use strict';

/** The first `max` lines, plus one saying how many of `total` were left out and how to narrow the list. */
function limitLines(lines, max, hint, total = lines.length) {
  const shown = lines.slice(0, max);
  return total > shown.length ? [...shown, `... ${total - shown.length} more; ${hint}.`] : shown;
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Multi-line text joined into one line, as debuggers and language servers print messages over several. */
function singleLine(text) {
  return text.replace(/\s*\n\s*/g, ' ');
}

const LINE_PREVIEW_CHARS = 200;

/** A trimmed source line cut to a readable length, for result lists. */
function linePreview(text) {
  return text.trim().slice(0, LINE_PREVIEW_CHARS);
}

/** "line:column" of a 0-based position, 1-based as editors show it. */
function positionText({ line, character }) {
  return `${line + 1}:${character + 1}`;
}

/** "start-end" of a range, or the start alone when the range is empty. */
function rangeText({ start, end, isEmpty }) {
  return isEmpty ? positionText(start) : `${positionText(start)}-${positionText(end)}`;
}

/** A package.json string, or undefined for a `%key%` placeholder that built-in extensions resolve elsewhere. */
function manifestText(text) {
  return typeof text === 'string' && !text.startsWith('%') ? text : undefined;
}

module.exports = { limitLines, plural, singleLine, linePreview, positionText, rangeText, manifestText };
