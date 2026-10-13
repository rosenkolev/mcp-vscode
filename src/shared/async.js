'use strict';

/**
 * Resolves with `{ done: true, value }` when `promise` settles first, or with `{ done: false }` once
 * `timeoutMs` passes. A rejection of `promise` propagates.
 */
async function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve(promise).then((value) => ({ done: true, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves with the first value of `event` that `matches`, or with undefined once `timeoutMs` passes. */
function nextEvent(event, matches, timeoutMs) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(value);
    };
    const subscription = event((value) => matches(value) && finish(value));
    const timer = setTimeout(() => finish(undefined), timeoutMs);
  });
}

/** One event that fires whenever any of `events` fires. */
function anyEvent(...events) {
  return (listener) => {
    const subscriptions = events.map((event) => event(listener));
    return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
  };
}

module.exports = { withTimeout, nextEvent, anyEvent };
