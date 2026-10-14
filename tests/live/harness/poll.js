'use strict';

const POLL_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `check` returns a truthy value, polling until `timeoutMs` passes. */
async function eventually(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

module.exports = { eventually, sleep };
