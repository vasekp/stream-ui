import init, { stop_ptr, validate } from "./pkg/stream_wasm.js";

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
let historyIndex = -1;
let savedPartial = "";

// helper to append a line
function appendLine(line) {
  outputDiv.textContent += line + "\n";
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

// Validate input and enable/disable Run
function updateRunButton() {
  try {
    runButton.disabled = !validate(inputField.value);
  } catch {
    runButton.disabled = true; // fail-safe
  }
}

// Linear run handler
async function runCurrentInput() {
  const text = inputField.value.trim();
  if (!text || pending || !validate(text)) return;

  // store in history if not duplicate
  if (history.length === 0 || history[history.length - 1] !== text) {
    history.push(text);
  }

  inputField.value = "";
  historyIndex = -1;
  savedPartial = "";
  updateRunButton();

  appendLine(`> ${text}`);
  try {
    const result = await callWasm(text);
    appendLine(result);
  } catch (err) {
    appendLine(`Error: ${err}`);
  }
}

// Bind Run button click
runButton.addEventListener("click", runCurrentInput);

// Input events
inputField.addEventListener("input", updateRunButton);

inputField.addEventListener("keydown", (e) => {
  const lastIndex = history.length - 1;

  if (e.key === "Enter") {
    if (!runButton.disabled) {
      runCurrentInput();
    }
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (history.length === 0) return;

    if (historyIndex === -1) {
      savedPartial = inputField.value;
      historyIndex = lastIndex;
    } else if (historyIndex > 0) {
      historyIndex--;
    }
    inputField.value = history[historyIndex];
    updateRunButton();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    if (history.length === 0) return;

    if (historyIndex === -1) return;

    historyIndex++;
    if (historyIndex > lastIndex) {
      historyIndex = -1;
      inputField.value = savedPartial;
    } else {
      inputField.value = history[historyIndex];
    }
    updateRunButton();
  }
});

// optional: cancel computation with Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    setAtomic(1);
  }
});

// initialize Run button state
updateRunButton();
