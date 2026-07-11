import assert from "node:assert";
import { describe, it } from "node:test";
import { debounce } from "./debounce.js";

const createTimers = () => {
  let nextId = 0;
  const callbacks = new Map();

  return {
    setTimeout(callback) {
      const id = ++nextId;
      callbacks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      callbacks.delete(id);
    },
    flush() {
      for (const callback of callbacks.values()) callback();
      callbacks.clear();
    },
    pendingCount() {
      return callbacks.size;
    },
  };
};

describe("debounce", () => {
  it("runs only the latest call", () => {
    const timers = createTimers();
    const calls = [];
    const callback = debounce((value) => calls.push(value), 250, timers);

    callback("first");
    callback("second");
    timers.flush();

    assert.deepStrictEqual(calls, ["second"]);
  });

  it("cancels a pending call", () => {
    const timers = createTimers();
    const callback = debounce(() => {}, 250, timers);

    callback();
    callback.cancel();

    assert.strictEqual(timers.pendingCount(), 0);
  });
});
