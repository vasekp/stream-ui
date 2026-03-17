import init, { stop, validate } from "./pkg/stream_wasm.js";

let worker;

let pending = null;

async function start() {
  const wasm = await init();

  worker = new Worker("./worker.js", { type: "module" });

  worker.postMessage({ type: "init", memory: wasm.memory });

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

// DOM references
const inputField = document.getElementById("input");
const outputDiv = document.getElementById("output");
const runButton = document.getElementById("run");

// keep original handler for reuse
function runButtonHandler(e) {
  runCurrentInput();
}

// helper to toggle button state with one class; stop action immediate
function setRunButtonBusy(busy) {
  if (busy) {
    runButton.onclick = () => stop();
    runButton.classList.add("busy");
  } else {
    runButton.classList.remove("busy");
    runButton.onclick = runButtonHandler;
  }
}

// History
const history = [];
let historyIndex = -1;
let savedPartial = "";

// count of outputs we have added (used for data-num)
let outputCount = 0;

// Detail panel infinite scroll
const detailPanel = document.getElementById("detail-panel");
const detailList = document.getElementById("detail-list");
let currentGenerator = null;
let generatorExhausted = false;
let isLoadingMore = false;

// Mock generator function (will be replaced with real data from clicked output)
function* mockGenerator() {
  let count = 0;
  while (true) {
    yield `Item ${count++}`;
    if (count > 1000) break; // prevent truly infinite for testing
  }
}

// Open detail panel with generator
function openDetailPanel(generator) {
  currentGenerator = generator;
  generatorExhausted = false;
  isLoadingMore = false;
  
  // Clear list
  detailList.innerHTML = "";
  
  // Show panel
  detailPanel.classList.remove("panel-hidden");
  
  // Create overlay
  createOverlay();
  
  // Load initial batch
  loadMoreItems();
}

// Close detail panel
function closeDetailPanel() {
  detailPanel.classList.add("panel-hidden");
  currentGenerator = null;
  detailList.innerHTML = "";
  removeOverlay();
}

// Load more items from generator
function loadMoreItems() {
  if (!currentGenerator || generatorExhausted || isLoadingMore) return;
  
  isLoadingMore = true;
  
  // Load a batch of items (e.g., 20 at a time)
  for (let i = 0; i < 20; i++) {
    const result = currentGenerator.next();
    
    if (result.done) {
      generatorExhausted = true;
      break;
    }
    
    const itemDiv = document.createElement("div");
    itemDiv.className = "item";
    itemDiv.textContent = result.value;
    detailList.appendChild(itemDiv);
  }
  
  isLoadingMore = false;
}

// Detect when scrolling near bottom to load more
detailList.addEventListener("scroll", (e) => {
  const element = e.target;
  // Load more when within 100px of bottom
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 100) {
    if (!generatorExhausted && !isLoadingMore) {
      loadMoreItems();
    }
  }
});

// Create and attach overlay for closing
function createOverlay() {
  let overlay = document.getElementById("detail-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "detail-overlay";
    document.body.appendChild(overlay);
  }
  overlay.classList.add("panel-active");
  overlay.onclick = closeDetailPanel;
}

function removeOverlay() {
  const overlay = document.getElementById("detail-overlay");
  if (overlay) {
    overlay.classList.remove("panel-active");
    overlay.onclick = null;
  }
}

function appendLine(line, className, dataNum) {
  const lineDiv = document.createElement("div");
  if (className) {
    lineDiv.className = className;
  }
  if (dataNum !== undefined && dataNum !== null) {
    lineDiv.dataset.num = dataNum;
  }
  lineDiv.textContent = line;
  outputDiv.appendChild(lineDiv);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

// Resize textarea to fit content up to max lines
function resizeInput() {
  inputField.style.height = "auto";
  inputField.style.height = `${inputField.scrollHeight}px`;
}

// Validate input and enable/disable Run
function updateRunButton() {
  resizeInput();
  /*try {
    runButton.disabled = !validate(inputField.value);
  } catch {
    runButton.disabled = true; // fail-safe
  }*/
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

  appendLine(text, "input");
  setRunButtonBusy(true);
  try {
    const result = await callWasm(text);
    outputCount += 1;
    appendLine(result, "output", outputCount);
  } catch (err) {
    appendLine(`Error: ${err}`, "error");
  } finally {
    setRunButtonBusy(false);
  }
}

// Bind Run button click
runButton.addEventListener("click", runCurrentInput);

// Input events
inputField.addEventListener("input", updateRunButton);

// ensure initial height
resizeInput();

inputField.addEventListener("keydown", (e) => {
  const lastIndex = history.length - 1;

  if (e.key === "Enter" && !e.shiftKey) {
    if (!runButton.disabled) {
      runCurrentInput();
    }
    e.preventDefault();
    return;
  }

  if (e.key === "ArrowUp") {
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
    stop();
  }
});

// clicking a past output div should open detail panel
outputDiv.addEventListener("click", (e) => {
  const target = e.target;
  
  // input items are clickable to recall
  if (target.classList && target.classList.contains("input")) {
    inputField.value = target.textContent;
    updateRunButton();
    inputField.focus();
    const len = inputField.value.length;
    inputField.setSelectionRange(len, len);
    return;
  }
  
  // output items open detail panel
  if (target.classList && target.classList.contains("output")) {
    openDetailPanel(mockGenerator());
    return;
  }
  
  // error items open detail panel
  if (target.classList && target.classList.contains("error")) {
    openDetailPanel(mockGenerator());
    return;
  }
});

// initialize Run button state
updateRunButton();
