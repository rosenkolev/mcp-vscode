'use strict';

function oldName(value) {
  return value * 2;
}

function useIt( x ){ return oldName(x) }

const label = 'text';

module.exports = { useIt, label };
