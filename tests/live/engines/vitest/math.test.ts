import { describe, expect, test } from 'vitest';
import { add, subtract } from './math';

describe('math', () => {
  test('adds', () => {
    expect(add(1, 2)).toBe(3);
  });

  test('subtracts', () => {
    expect(subtract(3, 1)).toBe(1);
  });

  test.skip('skipped', () => {});
});
