let ticks = 0;
const timer = setInterval(() => {
  ticks += 1;
  if (ticks > 120) {
    clearInterval(timer);
  }
}, 500);
