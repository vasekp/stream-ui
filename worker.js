import init, { process } from "./pkg/stream_wasm.js";

await init();

self.onmessage = (e) => {

  const { id, input } = e.data;

  const result = process(input);

  self.postMessage({
    id,
    result
  });

};
