import init, { stop_ptr } from "./pkg/stream_wasm.js";

let worker;
let stop;

let pending = new Map();
let nextId = 1;

async function start() {
  const wasm = await init();

  const ptr = stop_ptr();

  stop = new Int32Array(
    wasm.memory.buffer,
    ptr,
    1
  );

  worker = new Worker("./worker.js", { type: "module" });

  worker.onmessage = (e) => {
    const { id, result } = e.data;

    const resolve = pending.get(id);
    pending.delete(id);

    resolve(result);
  };
}

await start();

export function callWasm(input) {
  return new Promise((resolve) => {

    const id = nextId++;

    pending.set(id, resolve);

    worker.postMessage({
      id,
      input
    });

  });
}

export function setAtomic(value) {
  Atomics.store(stop, 0, value);
}
