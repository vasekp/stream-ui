import init, { process } from "./pkg/stream_wasm.js";

await init();

let busy = false;

self.onmessage = (e) => {
  const { input } = e.data;

  if (busy) return; // ignore concurrent calls
  busy = true;

  try {
    const result = process(input);
    self.postMessage({ result });
  } finally {
    busy = false;
  }
};
