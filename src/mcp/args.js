'use strict';

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: Number.isInteger,
  array: Array.isArray,
};

function toRegex(key, source) {
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    throw new Error(`"${key}" is not a valid regular expression: ${error.message}`);
  }
}

function checkRange(key, value, { minimum, maximum }) {
  if (value < (minimum ?? -Infinity) || value > (maximum ?? Infinity)) {
    const bounds = [minimum !== undefined && `at least ${minimum}`, maximum !== undefined && `at most ${maximum}`];
    throw new Error(`"${key}" must be ${bounds.filter(Boolean).join(' and ')}.`);
  }
}

/**
 * Validates tool arguments against the tool's input schema and fills in its defaults. Supports the
 * subset the tools use: string, boolean, integer and array properties, `enum`, `minimum`/`maximum`, and
 * `format: 'regex'`, which yields a case-insensitive RegExp. An empty string counts as missing.
 */
function parseArgs({ properties = {}, required = [] }, args) {
  const parsed = {};
  for (const [key, spec] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null || value === '') {
      if (required.includes(key)) {
        throw new Error(`"${key}" is required.`);
      }
      parsed[key] = spec.default;
      continue;
    }
    const isType = TYPE_CHECKS[spec.type];
    if (!isType) {
      throw new Error(`"${key}" has the unsupported schema type "${spec.type}".`);
    }
    if (!isType(value)) {
      throw new Error(`"${key}" must be of type ${spec.type}.`);
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw new Error(`"${key}" must be one of: ${spec.enum.join(', ')}.`);
    }
    checkRange(key, value, spec);
    parsed[key] = spec.format === 'regex' ? toRegex(key, value) : value;
  }
  return parsed;
}

module.exports = { parseArgs };
