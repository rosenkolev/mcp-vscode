const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { add, subtract } = require('./math');

describe('math', () => {
  test('adds', () => {
    assert.equal(add(1, 2), 3);
  });

  test('subtracts', () => {
    assert.equal(subtract(3, 1), 1);
  });

  test.skip('skipped', () => {});
});
