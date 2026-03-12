import init, { process } from "./pkg/stream_wasm.js";

let busy = false;

self.onmessage = async (e) => {
  if (e.data.type === "init") {
    await init(undefined, e.data.memory);
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
