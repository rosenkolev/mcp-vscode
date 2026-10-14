'use strict';

const MAX_PATTERN_LENGTH = 1000;

const TYPE_CHECKS = {
  string: (value) => typeof value === 'string',
  boolean: (value) => typeof value === 'boolean',
  integer: Number.isInteger,
  array: Array.isArray,
  object: (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
};

function toRegex(key, source) {
  if (source.length > MAX_PATTERN_LENGTH) {
    throw new Error(`"${key}" is longer than ${MAX_PATTERN_LENGTH} characters.`);
  }
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

/** A copy of a default, so a handler that changes an array or object default cannot affect later calls. */
function cloneDefault(value) {
  return typeof value === 'object' && value !== null ? structuredClone(value) : value;
}

/** Validates one value against its property spec and returns it, converted where the spec asks. */
function parseValue(key, value, spec) {
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
  if (spec.type === 'array' && spec.items) {
    return value.map((item, index) => parseValue(`${key}[${index}]`, item, spec.items));
  }
  if (spec.type === 'object' && spec.properties) {
    return parseArgs(spec, value, key);
  }
  checkRange(key, value, spec);
  return spec.format === 'regex' ? toRegex(key, value) : value;
}

/**
 * Validates tool arguments against the tool's input schema and fills in its defaults. Supports the
 * subset the tools use: string, boolean, integer, array and object properties (items and nested
 * properties included), `enum`, `minimum`/`maximum`, and `format: 'regex'`, which yields a
 * case-insensitive RegExp. An empty string counts as missing.
 */
function parseArgs({ properties = {}, required = [] }, args, prefix = '') {
  const parsed = {};
  for (const [name, spec] of Object.entries(properties)) {
    const key = prefix ? `${prefix}.${name}` : name;
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      if (required.includes(name)) {
        throw new Error(`"${key}" is required.`);
      }
      parsed[name] = cloneDefault(spec.default);
      continue;
    }
    parsed[name] = parseValue(key, value, spec);
  }
  return parsed;
}

module.exports = { parseArgs };
