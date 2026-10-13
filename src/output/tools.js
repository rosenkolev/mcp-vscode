'use strict';

const vscodeUnofficial = require('../unofficial/vscode-unofficial');
const { NO_ARGS, filterProperty, maxLinesProperty } = require('../shared/schema');

/** The channel named `name`, or the only one whose name contains it, ignoring case. */
function pickChannel(channels, name) {
  const needle = name.toLowerCase();
  const exact = channels.filter((channel) => channel.name.toLowerCase() === needle);
  const matches = exact.length ? exact : channels.filter((channel) => channel.name.toLowerCase().includes(needle));
  if (matches.length === 1) {
    return matches[0];
  }
  throw new Error(
    matches.length
      ? `"${name}" matches several channels: ${matches.map((channel) => channel.name).join(', ')}.`
      : `No Output channel "${name}". list_output_channels shows them.`,
  );
}

function outputTools() {
  const { outputChannels } = vscodeUnofficial;
  return [
    {
      name: 'list_output_channels',
      description: 'List the Output panel channels of extensions (Git, TypeScript, ESLint, ...).',
      inputSchema: NO_ARGS,
      handler: async () => {
        const channels = await outputChannels.list();
        return channels.map(({ name, extension }) => `${name}${extension ? ` (${extension})` : ''}`).join('\n') || 'No Output channels.';
      },
    },
    {
      name: 'read_output_channel',
      description: 'Read the latest lines of an Output panel channel, e.g. "Git", "TypeScript" or "ESLint".',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Channel name, or a unique part of it, from list_output_channels.' },
          filter: filterProperty,
          max_lines: maxLinesProperty,
        },
        required: ['name'],
      },
      handler: async ({ name, filter, max_lines }) => {
        const channel = pickChannel(await outputChannels.list(), name);
        const lines = await outputChannels.read(channel.name);
        const selected = (filter ? lines.filter((line) => filter.test(line)) : lines).slice(-max_lines);
        return [`${channel.name}: last ${selected.length} of ${lines.length} lines${filter ? ', filtered' : ''}.`, '---', ...selected].join('\n');
      },
    },
  ];
}

module.exports = { outputTools };
