import init, { stop_ptr } from "./pkg/stream_wasm.js";

let worker;
let stop;

let pending = null;

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
    const { result } = e.data;

    if (pending) {
      const { resolve } = pending;
      pending = null;
      resolve(result);
    }
  };
}

await start();

export function callWasm(input) {
  if (pending) throw new Error("Call already in progress");

  return new Promise((resolve) => {
    pending = { resolve };
    worker.postMessage({ input });
  });
}

export function setAtomic(value) {
  Atomics.store(stop, 0, value);
}

// DOM references
const inputField = document.getElementById("input");
const outputDiv = document.getElementById("output");
const runButton = document.getElementById("run");

// History
const history = [];
let historyIndex = -1; // -1 means new input
let savedPartial = ""; // partially typed input when navigating

async function runCurrentInput() {
  const text = inputField.value.trim();
  if (!text || pending) return; // block if busy

  // Add to history if different from last
  if (history.length === 0 || history[history.length - 1] !== text) {
    history.push(text);
  }

  inputField.value = ""; // clear input
  historyIndex = -1;     // reset navigation
  savedPartial = "";

  appendLine(`> ${text}`);
  try {
    const result = await callWasm(text);
    appendLine(result);
  } catch (err) {
    appendLine(`Error: ${err}`);
  }
}

// append a line to the output div
function appendLine(line) {
  outputDiv.textContent += line + "\n";
  outputDiv.scrollTop = outputDiv.scrollHeight;
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
