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

// handle input and Enter key
const inputField = document.getElementById("input");
const outputDiv = document.getElementById("output");
const runButton = document.getElementById("run");

async function runCurrentInput() {
  const text = inputField.value.trim();
  if (!text) return;

  inputField.value = ""; // clear input
  outputDiv.textContent = "Processing…";

  try {
    const result = await callWasm(text);
    outputDiv.textContent = result;
  } catch (err) {
    outputDiv.textContent = `Error: ${err}`;
  }
}

// bind both button click and Enter key
runButton.addEventListener("click", runCurrentInput);

inputField.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    runCurrentInput();
  }
});

// optional: cancel computation with Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setAtomic(1);
  }
});
