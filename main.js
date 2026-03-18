import init, { stop, validate } from "./pkg/stream_wasm.js";

let worker;

let pending = null;
const ERR_SUFFIX = "<!>";

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
const inputField = document.getElementById("edit-real");
const mirrorField = document.getElementById("edit-mirror");
const outputDiv = document.getElementById("output");
const runButton = document.getElementById("run");

// keep original handler for reuse
function runButtonHandler() {
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
      setLineContent(itemDiv, value.value, true);
    } else if (value.type === "error") {
      // Create error with backtrace in detail panel
      const errorDiv = document.createElement("div");
      errorDiv.className = "error";
      
      // Create label that wraps all content
      const label = document.createElement("label");
      label.className = "error-label";
      
      // Create hidden checkbox inside label for implicit association
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "error-toggle";
      label.appendChild(checkbox);
      
      // Add backtrace if present
      if (value.trace && Array.isArray(value.trace) && value.trace.length > 0) {
        const traceDiv = document.createElement("div");
        traceDiv.className = "error-trace";
        value.trace.forEach((line) => {
          const traceLine = document.createElement("div");
          traceLine.className = "error-trace-line";
          traceLine.textContent = line;
          traceDiv.appendChild(traceLine);
        });
        label.appendChild(traceDiv);
      }
      
      // Add error message
      const messageDiv = document.createElement("div");
      messageDiv.className = "error-message";
      messageDiv.textContent = value.text;
      label.appendChild(messageDiv);
      
      errorDiv.appendChild(label);
      
      generatorExhausted = true; // stop on error, don't process further responses
      isLoadingMore = false;
      detailList.append(errorDiv);
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

function setLineContent(element, line, highlightErrSuffix = false) {
  if (
    highlightErrSuffix &&
    typeof line === "string" &&
    line.endsWith(ERR_SUFFIX)
  ) {
    const base = line.slice(0, -ERR_SUFFIX.length);
    element.append(document.createTextNode(base));

    const suffixSpan = document.createElement("span");
    suffixSpan.className = "err-suffix";
    suffixSpan.textContent = ERR_SUFFIX;
    element.append(suffixSpan);
    return;
  }

  element.textContent = line;
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
  let highlightErrSuffix = className === "output";
  setLineContent(lineDiv, line, highlightErrSuffix);
  outputDiv.appendChild(lineDiv);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

// Append error with collapsible backtrace
function appendError(errorText, backtrace) {
  const errorDiv = document.createElement("div");
  errorDiv.className = "error";
  
  // Create label that wraps all content
  const label = document.createElement("label");
  label.className = "error-label";
  
  // Create hidden checkbox inside label for implicit association
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "error-toggle";
  label.appendChild(checkbox);
  
  // Add backtrace if present
  if (backtrace && Array.isArray(backtrace) && backtrace.length > 0) {
    const traceDiv = document.createElement("div");
    traceDiv.className = "error-trace";
    backtrace.forEach((line) => {
      const traceLine = document.createElement("div");
      traceLine.className = "error-trace-line";
      traceLine.textContent = line;
      traceDiv.appendChild(traceLine);
    });
    label.appendChild(traceDiv);
  }
  
  // Add error message
  const messageDiv = document.createElement("div");
  messageDiv.className = "error-message";
  messageDiv.textContent = errorText;
  label.appendChild(messageDiv);
  
  errorDiv.appendChild(label);
  
  outputDiv.appendChild(errorDiv);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

function resetInput(text) {
  inputField.textContent = text;
  inputField.focus();
  const range = document.createRange();
  const sel = window.getSelection();
  range.selectNodeContents(inputField);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
  updateInputMirror();
}

function updateInputMirror() {
  const check = validate(inputField.textContent);
  let text = inputField.innerText;
  if(check.range !== undefined) {
    let [start, end] = check.range;
    let mark = document.createElement('span');
    mark.classList.add('error');
    mark.textContent = text.substring(start, end);
    mirrorField.replaceChildren();
    mirrorField.append(text.substring(0, start));
    mirrorField.append(mark);
    mirrorField.append(text.substring(end));
  } else {
    mirrorField.textContent = text;
  }
}

// Linear run handler
async function runCurrentInput() {
  const text = inputField.textContent.trim();
  if (!text || pending) return;

  if (validate(inputField.textContent).valid == true) {
    resetInput("");
  }

  appendLine(text, "input");
  setRunButtonBusy(true);
  try {
    const result = await callWasm(text);
    
    if (result.type === "item") {
      appendLine(result.value, "output", result.history, result.itemType);
    } else if (result.type === "globals") {
      appendLine(result.value, "output");
    } else if (result.type === "error") {
      appendError(result.text, result.trace);
    }
  } catch (err) {
    appendError(`Error: ${err}`, null);
  } finally {
    setRunButtonBusy(false);
  }
}

// Bind Run button click
runButton.addEventListener("click", runCurrentInput);

// Input events
inputField.addEventListener("input", updateInputMirror);

inputField.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    runCurrentInput();
    e.preventDefault();
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
  if (target.classList.contains("input")) {
    resetInput(target.textContent);
    return;
  }
  
  // output items open detail panel only if itemType is "stream"
  if (target.classList.contains("output")) {
    if (target.dataset.itemType === "stream") {
      openDetailPanel(target.dataset.num);
    }
    return;
  }
});

inputField.focus();
