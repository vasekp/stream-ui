import init, { stop, validate } from "./pkg/stream_wasm.js";

let worker;

let pending = null;

async function start() {
  const wasm = await init();

  worker = new Worker("./worker.js", { type: "module" });

  worker.postMessage({ type: "init", memory: wasm.memory });

  worker.onmessage = (e) => {
    const { result, iterResult } = e.data;
    
    if (iterResult !== undefined) {
      // Handle iterator result
      if (pendingIteratorRequest) {
        pendingIteratorRequest(iterResult);
      }
    }
    
    if (result !== undefined && pending) {
      // Handle regular process result
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
const sentinelElement = document.getElementById("detail-sentinel");
let currentIteratorNum = null;
let generatorExhausted = false;
let isLoadingMore = false;
let pendingIteratorRequest = null;
let sentinelVisible = false; // track sentinel visibility
let intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target === sentinelElement) {
          sentinelVisible = entry.isIntersecting;
          if (sentinelVisible) {
            loadMoreItems();
          }
        }
      });
    });
sentinelElement.onclick = () => stop();

// Open detail panel with iterator from worker
function openDetailPanel(dataNum) {
  currentIteratorNum = dataNum;
  generatorExhausted = false;
  isLoadingMore = false;
  
  // Remove all children except sentinel
  detailList.replaceChildren();
  
  // Show sentinel
  sentinelElement.hidden = false;
  sentinelVisible = true;
  
  // Show panel
  detailPanel.classList.remove("panel-hidden");
  
  // Create overlay
  createOverlay();
  
  // Request iterator from worker
  worker.postMessage({ type: "get_iter", num: dataNum });
  
  // Set up intersection observer
  intersectionObserver.observe(sentinelElement);
  
  // Load initial item
  loadMoreItems();
}

// Close detail panel
function closeDetailPanel() {
  detailPanel.classList.add("panel-hidden");
  generatorExhausted = true; // prevent further responses from being processed
  currentIteratorNum = null;
  sentinelVisible = false;
  
  // Remove all children except sentinel
  detailList.replaceChildren();
  
  removeOverlay();
  
  // Unobserve sentinel
  intersectionObserver.unobserve(sentinelElement);

  if (isLoadingMore) {
    stop(); // stop any pending generator processing
  }
  
  worker.postMessage({ type: "iter_free" });
}

// Load more items from iterator via worker
function loadMoreItems() {
  if (currentIteratorNum === null || generatorExhausted || isLoadingMore) return;
  
  isLoadingMore = true;
  
  // Request a single item
  worker.postMessage({ type: "iter_next" });
  
  // Store a pending callback for when response comes back
  pendingIteratorRequest = (iterResult) => {
    // Don't process responses if panel is closed or we've already hit an error
    if (generatorExhausted || currentIteratorNum === null) return;
    
    if (iterResult.done) {
      generatorExhausted = true;
      isLoadingMore = false;
      sentinelElement.hidden = true;
      return;
    }
    
    const value = iterResult.value;
    const itemDiv = document.createElement("div");
    
    if (value.type === "item") {
      itemDiv.className = "item";
      itemDiv.textContent = value.value;
    } else if (value.type === "error") {
      itemDiv.className = "error";
      itemDiv.textContent = value.text;
      generatorExhausted = true; // stop on error, don't process further responses
      isLoadingMore = false;
      detailList.append(itemDiv);
      sentinelElement.hidden = true;
      return;
    }
    
    detailList.append(itemDiv);
    isLoadingMore = false;
    
    // If sentinel is visible, load another item
    if (sentinelVisible) {
      loadMoreItems();
    }
  };
}

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

function appendLine(line, className, dataNum, itemType) {
  const lineDiv = document.createElement("div");
  if (className) {
    lineDiv.className = className;
  }
  if (dataNum !== undefined && dataNum !== null) {
    lineDiv.dataset.num = dataNum;
  }
  if (itemType !== undefined && itemType !== null) {
    lineDiv.dataset.itemType = itemType;
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
    
    if (result.type === "item") {
      appendLine(result.value, "output", result.history, result.itemType);
    } else if (result.type === "globals") {
      appendLine(result.value, "output");
    } else if (result.type === "error") {
      appendLine(result.text, "error");
    }
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
  
  // output items open detail panel only if itemType is "stream"
  if (target.classList && target.classList.contains("output")) {
    if (target.dataset.itemType === "stream") {
      openDetailPanel(target.dataset.num);
    }
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
