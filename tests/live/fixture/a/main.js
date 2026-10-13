const { total } = require('./calc');

const result = total([1, 2, 3]);
console.log('total', result);
let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  if (ticks > 120) {
    clearInterval(timer);
  }
}, 500);
