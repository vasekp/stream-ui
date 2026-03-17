import init, { process, get_iter } from "./pkg/stream_wasm.js";

let busy = false;
let currentIterator = null;

self.onmessage = async (e) => {
  if (e.data.type === "init") {
    await init(undefined, e.data.memory);
  } else if (e.data.type === "get_iter") {
    const { num } = e.data;
    currentIterator = get_iter(num);
  } else if (e.data.type === "iter_next") {
    if (currentIterator) {
      const result = currentIterator.next();
      self.postMessage({ iterResult: result });
    }
  } else if (e.data.type === "iter_free") {
    if (currentIterator) {
      currentIterator.free();
      currentIterator = null;
    }
  } else {
    const { input } = e.data;

    if (busy) return; // ignore concurrent calls
    busy = true;

    try {
      const result = process(input);
      self.postMessage({ result });
    } finally {
      busy = false;
    }
  }
};
