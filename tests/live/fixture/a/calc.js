'use strict';

function addNumbers(a, b) {
  return a + b;
}

function total(items) {
  let sum = 0;
  for (const item of items) {
    sum = addNumbers(sum, item);
  }
  return sum;
}

module.exports = { total };
