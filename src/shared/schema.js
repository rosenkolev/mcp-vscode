'use strict';

/** Input-schema building blocks shared by the tools. */

const NO_ARGS = { type: 'object', properties: {} };

const pathProperty = {
  type: 'string',
  description:
    'File path: absolute, or relative to the workspace. In a multi-root workspace it may start with a folder name, as other tools print paths.',
};

const maxResultsProperty = { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: 'Maximum results to return.' };

const maxLinesProperty = { type: 'integer', minimum: 1, maximum: 2000, default: 80, description: 'Maximum output lines to return.' };

const filterProperty = { type: 'string', format: 'regex', description: 'Case-insensitive regex; return only matching lines.' };

function timeoutProperty(defaultSeconds, description, maximum = 600) {
  return { type: 'integer', minimum: 1, maximum, default: defaultSeconds, description: `Wait limit in seconds. ${description}` };
}

module.exports = { NO_ARGS, pathProperty, maxResultsProperty, maxLinesProperty, filterProperty, timeoutProperty };
