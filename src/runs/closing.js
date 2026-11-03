'use strict';

/** Input-schema properties of tools whose terminal closes by itself once its command or task ends. */

const DEFAULT_CLOSE_DELAY_SECONDS = 3;

const closingProperties = (what) => ({
  keep_open: {
    type: 'boolean',
    default: false,
    description: `Keep the terminal open after the ${what} ends, so the user can look at its output.`,
  },
  close_delay_seconds: {
    type: 'integer',
    minimum: 0,
    maximum: 3600,
    default: DEFAULT_CLOSE_DELAY_SECONDS,
    description: `Seconds the terminal stays open after the ${what} ends, so the user can see the result. Ignored with keep_open.`,
  },
});

module.exports = { closingProperties, DEFAULT_CLOSE_DELAY_SECONDS };
