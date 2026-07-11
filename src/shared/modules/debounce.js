export const debounce = (callback, delay, timers = globalThis) => {
  let timeoutId = null;

  const debounced = (...args) => {
    if (timeoutId !== null) {
      timers.clearTimeout(timeoutId);
    }

    timeoutId = timers.setTimeout(() => {
      timeoutId = null;
      callback(...args);
    }, delay);
  };

  debounced.cancel = () => {
    if (timeoutId !== null) {
      timers.clearTimeout(timeoutId);
      timeoutId = null;
    }
  };

  return debounced;
};
