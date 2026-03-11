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

// DOM references
const inputField = document.getElementById("input");
const outputDiv = document.getElementById("output");
const runButton = document.getElementById("run");

// history
const history = [];
let historyIndex = -1; // -1 means new input
let savedPartial = ""; // partially typed input when navigating

async function runCurrentInput() {
  const text = inputField.value.trim();
  if (!text) return;

  // Add to history if different from last
  if (history.length === 0 || history[history.length - 1] !== text) {
    history.push(text);
  }

  inputField.value = ""; // clear input
  historyIndex = -1;     // reset navigation
  savedPartial = "";

  outputDiv.textContent = "Processing…";

  try {
    const result = await callWasm(text);
    outputDiv.textContent = result;
  } catch (err) {
    outputDiv.textContent = `Error: ${err}`;
  }
}

// Bind run button
runButton.addEventListener("click", runCurrentInput);

// Input field key handling
inputField.addEventListener("keydown", (e) => {
  const lastIndex = history.length - 1;

  if (e.key === "Enter") {
    runCurrentInput();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (history.length === 0) return;

    // save partially typed input if first navigation
    if (historyIndex === -1) {
      savedPartial = inputField.value;
      historyIndex = lastIndex;
    } else if (historyIndex > 0) {
      historyIndex--;
    }

    inputField.value = history[historyIndex];
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (history.length === 0) return;

    if (historyIndex === -1) return; // already in new input

    historyIndex++;
    if (historyIndex > lastIndex) {
      // restore partially typed input
      historyIndex = -1;
      inputField.value = savedPartial;
    } else {
      inputField.value = history[historyIndex];
    }
  }
});

// optional: cancel computation with Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setAtomic(1);
  }
});
