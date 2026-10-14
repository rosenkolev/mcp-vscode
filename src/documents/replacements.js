'use strict';

/**
 * Exact-text replacements in a document, as pure functions on strings: validation, overlap checks and
 * the expected result. No VS Code access, so the rules are unit-tested on their own.
 */

/** `text` with the line endings `eol` ("\n" or "\r\n"), so a caller's "\n" matches a CRLF file. */
function withEol(text, eol) {
  const normalized = text.replace(/\r\n/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

/** Offset of the one occurrence of `oldText`; throws when it is missing or not unique. */
function uniqueOffset(text, oldText, index) {
  const first = text.indexOf(oldText);
  if (first < 0) {
    throw new Error(`Edit ${index + 1}: "old_text" is not in the file. It must match exactly, including whitespace.`);
  }
  if (text.indexOf(oldText, first + 1) >= 0) {
    const count = text.split(oldText).length - 1;
    throw new Error(`Edit ${index + 1}: "old_text" occurs ${count} times. Add surrounding lines so it occurs once.`);
  }
  return first;
}

/**
 * Validated replacements `{ index, start, end, newText }` of `edits` (`{ old_text, new_text }`) in
 * `text`, in file order, with the document's line endings. Throws for an edit that is malformed,
 * missing, ambiguous, or overlapping another, nested ones included.
 */
function toReplacements(text, edits, eol) {
  const replacements = edits.map((edit, index) => {
    if (!edit || typeof edit.old_text !== 'string' || !edit.old_text || typeof edit.new_text !== 'string') {
      throw new Error(`Edit ${index + 1} needs a non-empty "old_text" string and a "new_text" string.`);
    }
    const oldText = withEol(edit.old_text, eol);
    const start = uniqueOffset(text, oldText, index);
    return { index, start, end: start + oldText.length, newText: withEol(edit.new_text, eol) };
  });
  replacements.sort((a, b) => a.start - b.start || a.end - b.end);
  let reach = -1;
  let last;
  for (const replacement of replacements) {
    if (replacement.start < reach) {
      throw new Error(`Edits ${last.index + 1} and ${replacement.index + 1} overlap.`);
    }
    if (replacement.end > reach) {
      reach = replacement.end;
      last = replacement;
    }
  }
  return replacements;
}

/** The text with every replacement applied. */
function applyReplacements(text, replacements) {
  let result = '';
  let position = 0;
  for (const { start, end, newText } of replacements) {
    result += text.slice(position, start) + newText;
    position = end;
  }
  return result + text.slice(position);
}

module.exports = { withEol, toReplacements, applyReplacements };
