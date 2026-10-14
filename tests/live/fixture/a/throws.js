'use strict';

function parse(text) {
  if (!text) {
    throw new TypeError('nothing to parse');
  }
  return JSON.parse(text);
}

console.log('before the throw');
setTimeout(() => parse(''), 500);
