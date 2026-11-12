// The language engine. It is loaded by start(), and loaded anew as a separate instance in the
// rare case that the old one has to be abandoned: see resetSession().
let stop, validate, help;
let instanceId = 0;
// How long a reset waits for the worker to finish what it is doing before giving up on it.
const RESET_PATIENCE_MS = 1500;

const ERR_SUFFIX = "<!>";
const SYMBOLS = [".", ":", "#", "%", "$", "{", "}", "[", "]", "(", ")", '"', "'", "@", "~", "^", "=", "<", ">", "&", "|", ";"];
const PAGE_SIZE = 50;

const $ = (id) => document.getElementById(id);

const editor = $("edit-real");
const mirror = $("edit-mirror");
const field = $("field");
const composer = $("composer");
const runButton = $("run");
const runIcon = $("run-icon");
const statusLine = $("status");
const scroller = $("scroller");
const log = $("log");
const welcome = $("welcome");
const workspace = $("workspace");

const coarsePointer = matchMedia("(pointer: coarse)");
const wideScreen = matchMedia("(min-width: 64rem)");

// ---------- Small DOM helpers ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

// A value as printed by the session; a trailing <!> marks an error inside a stream.
function valueNode(text) {
  const code = el("code", { class: "val" });
  if (typeof text === "string" && text.endsWith(ERR_SUFFIX)) {
    code.append(text.slice(0, -ERR_SUFFIX.length), el("span", { class: "err-suffix" }, ERR_SUFFIX));
  } else {
    code.textContent = text;
  }
  return code;
}

function failureNode(text, trace) {
  const box = el("div", { class: "failure" }, text);
  if (Array.isArray(trace) && trace.length > 0) {
    box.append(
      el("details", {},
        el("summary", {}, `Backtrace (${trace.length})`),
        el("ol", {}, ...trace.map((line) => el("li", {}, line)))));
  }
  return box;
}

// ---------- Worker ----------

let worker;
let nextCallId = 1;
const calls = new Map();
let ready = false;
let sessionId = 0; // tells results of a dropped session from the current one
// Set when the module has aborted. Its memory is in an unknown state then, so nothing calls
// into it any more, not even to validate input, until Clear replaces it.
let lost = false;
const LOST_MESSAGE = "Command failed, session lost. Hit Clear to reset.";

function markLost() {
  lost = true;
  $("clear").classList.add("attention");
}

// The text to show for a failed request; notes the loss of the session if that is what happened.
function failureText(err) {
  if (!err.fatal) return String(err.message ?? err);
  if (!lost) console.error("Stream aborted:", err.message);
  markLost();
  return LOST_MESSAGE;
}

// `onItem` receives the partial results that some requests report before they finish.
function rpc(op, args = {}, onItem) {
  return new Promise((resolve, reject) => {
    const id = nextCallId++;
    calls.set(id, { resolve, reject, onItem });
    worker.postMessage({ id, op, ...args });
  });
}

function showFatal(message) {
  const box = $("fatal");
  box.textContent = message;
  box.hidden = false;
  runButton.disabled = true;
}

// The engine needs a cross-origin isolated page. Where the server does not send the headers
// for that, a service worker adds them, and the page is loaded once more to come under it.
// Resolves to whether the page is isolated; does not resolve if it is being reloaded.
async function isolate() {
  const RETRY = "isolating"; // set while the reload is under way, so that it happens only once
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(RETRY);
    return true;
  }
  if (!navigator.serviceWorker || sessionStorage.getItem(RETRY)) {
    sessionStorage.removeItem(RETRY);
    return false;
  }
  try {
    await navigator.serviceWorker.register("./isolate.js");
    await navigator.serviceWorker.ready;
  } catch {
    return false;
  }
  sessionStorage.setItem(RETRY, "1");
  location.reload();
  return new Promise(() => {});
}

async function start() {
  if (!(await isolate())) {
    throw new Error(
      "This page must be served cross-origin isolated (COOP: same-origin, COEP: require-corp) to run Stream.");
  }
  // A query makes the module a separate instance, with a memory of its own.
  const engine = await import(instanceId === 0 ? "./pkg/stream_wasm.js" : `./pkg/stream_wasm.js?instance=${instanceId}`);
  const wasm = await engine.default();
  ({ stop, validate, help } = engine);
  worker = new Worker("./worker.js?v=4", { type: "module" });
  worker.onmessage = (e) => {
    const { id, value, error, fatal, item } = e.data;
    const call = calls.get(id);
    if (!call) return;
    if (item !== undefined) {
      call.onItem?.(item);
      return;
    }
    calls.delete(id);
    if (error !== undefined) call.reject(Object.assign(new Error(error), { fatal }));
    else call.resolve(value);
  };
  worker.onerror = (e) => showFatal(`Stream stopped working: ${e.message ?? "worker error"}. Reload the page to start again.`);
  await rpc("init", { memory: wasm.memory });
  ready = true;
}

// Drops everything: a running evaluation, the stream being browsed, the history and the
// variables.
async function resetSession() {
  if (!ready) return;
  ready = false; // nothing new starts until the fresh session is there
  sessionId += 1; // results still on their way belong to the old session and are ignored

  requestStop();
  setBusy(false);
  if (pager.mode !== "help") closePager(); // the reference does not depend on the session
  log.replaceChildren();
  welcome.hidden = false;
  setStatus();
  if (!coarsePointer.matches) editor.focus();

  if (!lost) {
    // The worker answers once whatever it was doing has stopped.
    const patience = new Promise((resolve) => setTimeout(resolve, RESET_PATIENCE_MS, false));
    const done = rpc("reset").then(() => true, () => false);
    if (await Promise.race([done, patience])) {
      ready = true;
      return;
    }
  }

  // The module has aborted, or it is stuck in something that cannot be interrupted. Either
  // way its memory cannot be trusted (a worker killed in mid-evaluation may leave it locked),
  // so the whole instance is replaced. The old memory stays allocated until the page is
  // reloaded.
  worker.terminate();
  for (const call of calls.values()) call.reject(new Error("session cleared"));
  calls.clear();
  iterInflight = null;
  instanceId += 1;
  lost = false;
  $("clear").classList.remove("attention");
  try {
    await start();
    updateMirror();
  } catch (err) {
    showFatal(String(err.message ?? err));
  }
}

// ---------- Editor ----------

function editorText() {
  return editor.textContent;
}

// The parser reports UTF-8 byte offsets; the DOM counts UTF-16 units.
function byteToIndex(text, byteOffset) {
  let bytes = 0;
  let index = 0;
  while (index < text.length && bytes < byteOffset) {
    const cp = text.codePointAt(index);
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    index += cp > 0xffff ? 2 : 1;
  }
  return index;
}

function updateMirror() {
  const text = editorText();
  const empty = text.trim() === "";
  mirror.toggleAttribute("data-empty", text === "" || text === "\n");
  let range;
  if (ready && !lost && !empty && !isHelpQuery(text)) {
    range = validate(text).range;
  }
  if (range) {
    const start = byteToIndex(text, range[0]);
    const end = byteToIndex(text, range[1]);
    mirror.replaceChildren(
      text.substring(0, start),
      el("mark", {}, text.substring(start, end) || " "),
      text.substring(end));
  } else {
    mirror.textContent = text;
  }
}

function setStatus(text = "", bad = false) {
  statusLine.textContent = text;
  statusLine.classList.toggle("bad", bad);
  field.classList.toggle("invalid", bad);
  if (bad) editor.setAttribute("aria-invalid", "true");
  else editor.removeAttribute("aria-invalid");
}

function caretToEnd() {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function setEditor(text, focus = true) {
  editor.textContent = text;
  if (focus) {
    editor.focus();
    caretToEnd();
  }
  setStatus();
  updateMirror();
}

function insertAtCaret(text) {
  const sel = getSelection();
  const inside = sel.rangeCount > 0 && editor.contains(sel.anchorNode) && document.activeElement === editor;
  if (!inside) {
    editor.focus();
    caretToEnd();
  }
  if (!document.execCommand("insertText", false, text)) {
    const range = getSelection().getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    editor.normalize();
  }
  setStatus();
  updateMirror();
}

// Buttons that type into the editor must not take the focus (and the on-screen keyboard) away.
function keepEditorFocus(e) {
  if (e.target.closest("[data-keep-focus]")) e.preventDefault();
}
document.addEventListener("mousedown", keepEditorFocus);

// ---------- Input recall ----------

const recall = { list: [], pos: null };

function remember(text) {
  if (recall.list.at(-1) !== text) recall.list.push(text);
  recall.pos = null;
}

function recallStep(delta) {
  const text = editorText();
  const browsing = recall.pos !== null && text === recall.list[recall.pos];
  if (!browsing && text.trim() !== "") return false;
  const from = browsing ? recall.pos : recall.list.length;
  const to = from + delta;
  if (to < 0 || to > recall.list.length) return browsing;
  recall.pos = to === recall.list.length ? null : to;
  setEditor(recall.pos === null ? "" : recall.list[to]);
  return true;
}

// ---------- Evaluation ----------

let evalBusy = false;
let stopRequested = false;
let busyTimer = null;
// The stream view's request in flight, if any. Only one request may be outstanding at a time,
// so that a stop always reaches the one it was meant for.
let iterInflight = null;

function setBusy(busy) {
  evalBusy = busy;
  document.body.classList.toggle("is-busy", busy);
  clearTimeout(busyTimer);
  const show = () => {
    runButton.classList.toggle("busy", busy);
    runButton.setAttribute("aria-label", busy ? "Stop" : "Run");
    runButton.title = busy ? "Stop (Esc)" : "Run (Enter)";
    runIcon.setAttribute("href", busy ? "#i-stop" : "#i-play");
  };
  // Quick evaluations should not make the button flicker.
  if (busy) busyTimer = setTimeout(show, 150);
  else show();
}

function requestStop() {
  if (lost) return;
  if (evalBusy) {
    stopRequested = true;
    stop();
  } else if (iterInflight) {
    stop();
  }
}

async function evaluate(text) {
  stopRequested = false;
  setBusy(true);
  try {
    if (iterInflight) {
      // The stream view is waiting for an item. A healthy listing reports back within a moment
      // and carries on afterwards; one that is stuck gives way to this evaluation.
      const pending = iterInflight;
      let settled = false;
      pending.then(() => (settled = true));
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 100))]);
      if (!settled) stop();
      await pending;
    }
    if (stopRequested) return { type: "error", text: "interrupted", trace: [] };
    return await rpc("process", { input: text });
  } catch (err) {
    return { type: "error", text: failureText(err), trace: [] };
  } finally {
    setBusy(false);
    pagerResume();
  }
}

function scrollToEnd() {
  scroller.scrollTop = scroller.scrollHeight;
}

function addEntry(text) {
  const reuse = el("button", { type: "button", class: "row-btn reuse", title: "Edit this input again" }, icon("edit"));
  reuse.setAttribute("aria-label", "Edit this input again");
  reuse.dataset.text = text;
  const out = el("div", { class: "out" }, el("span", { class: "note pending" }, "Running…"));
  const entry = el("li", { class: "entry" },
    el("div", { class: "in" }, el("span", { class: "prompt", "aria-hidden": "true" }, "›"), el("code", {}, text), reuse),
    out);
  welcome.hidden = true;
  log.append(entry);
  scrollToEnd();
  return out;
}

function fillEntry(out, result, text) {
  out.replaceChildren();
  if (result.type === "item") {
    const name = `%${result.history}`;
    const ref = el("button", { type: "button", class: "row-btn ref", title: `Insert ${name}` }, name);
    ref.dataset.insert = name;
    ref.dataset.keepFocus = "";
    out.append(ref, valueNode(result.value));
    if (result.itemType === "stream") {
      const browse = el("button", { type: "button", class: "row-btn browse" }, "Browse", icon("chevron"));
      browse.setAttribute("aria-label", `Browse the items of ${name}`);
      browse.dataset.num = result.history;
      browse.dataset.text = text;
      out.append(browse);
    }
  } else if (result.type === "globals") {
    const count = Number(result.names);
    const message = count === 0 ? "No variables changed"
      : count === 1 ? "1 variable updated"
      : `${count} variables updated`;
    out.append(el("span", { class: "note" }, message));
  } else {
    out.append(failureNode(result.text, result.trace));
  }
  scrollToEnd();
}

// Runs `text`, or the editor's contents when called without one.
async function run(text) {
  const fromEditor = text === undefined;
  if (fromEditor) text = editorText().trim();
  if (!ready || evalBusy) return;
  if (!text) {
    editor.focus();
    return;
  }
  if (lost) {
    setStatus(LOST_MESSAGE, true);
    return;
  }

  if (isHelpQuery(text)) {
    const name = helpName(text);
    const doc = openReference(name);
    if (doc.found) {
      remember(text);
      // Opening the panel takes the focus; give it back unless the panel covers the editor.
      if (fromEditor) setEditor("", !pager.el.matches(":modal"));
    } else {
      const advice = doc.topic ? ` Did you mean ??${name}?` : "";
      setStatus(`No documentation found for '${name}'.${advice}`, true);
    }
    return;
  }

  const session = sessionId;
  if (!validate(text).valid) {
    // Ask the session for the reason, but keep the input for fixing and the transcript clean.
    const result = await evaluate(text);
    if (session !== sessionId || lost) return;
    if (!fromEditor) setEditor(text, !coarsePointer.matches);
    setStatus(`Syntax error: ${result.text}`, true);
    return;
  }

  if (fromEditor) setEditor("");
  remember(text);
  const out = addEntry(text);
  const result = await evaluate(text);
  if (session === sessionId) fillEntry(out, result, text);
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  if (evalBusy) requestStop();
  else run();
});

editor.addEventListener("input", () => {
  setStatus();
  updateMirror();
});

editor.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    run();
  } else if (e.key === "ArrowUp" && !e.shiftKey) {
    if (recallStep(-1)) e.preventDefault();
  } else if (e.key === "ArrowDown" && !e.shiftKey) {
    if (recallStep(+1)) e.preventDefault();
  }
});

// A click anywhere in the input box lands in the editor.
field.addEventListener("click", (e) => {
  if (e.target === field || e.target.classList.contains("prompt")) editor.focus();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (evalBusy) {
    e.preventDefault(); // stop the evaluation first; a second Esc may then close the stream view
    requestStop();
  } else if (pager.el.open && !pager.el.matches(":modal")) {
    closePager();
  }
});

// Symbol keys for touch keyboards.
$("keys").append(...SYMBOLS.map((sym) => {
  const key = el("button", { type: "button", tabIndex: -1 }, sym);
  key.dataset.insert = sym;
  key.dataset.keepFocus = "";
  return key;
}));

$("keys").addEventListener("click", (e) => {
  const key = e.target.closest("button");
  if (key) insertAtCaret(key.dataset.insert);
});

$("samples").addEventListener("click", (e) => {
  const sample = e.target.closest("[data-run]");
  if (sample) run(sample.dataset.run);
});

log.addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.classList.contains("reuse")) setEditor(button.dataset.text);
  else if (button.classList.contains("ref")) insertAtCaret(button.dataset.insert);
  else if (button.classList.contains("browse")) openPager(Number(button.dataset.num), button.dataset.text, button);
});

$("clear").addEventListener("click", resetSession);

// ---------- Stream view ----------

const pager = {
  el: $("pager"),
  body: $("pager-body"),
  list: $("pager-list"),
  sentinel: $("pager-sentinel"),
  status: $("pager-status"),
  stopButton: $("pager-stop"),
  foot: $("pager-foot"),
  mode: null, // what the panel shows while open: "stream" or "help"
  num: null,
  token: null, // identifies the listing that requests belong to
  count: 0,
  finished: false,
  near: false, // the end of the list is in view, so more items are wanted
  opener: null,
  slowTimer: null,
};

function pagerStatus(text, loading = false) {
  pager.status.textContent = text;
  pager.stopButton.hidden = !loading;
}

function countText(n) {
  return n === 1 ? "1 item" : `${n} items`;
}

// The panel serves both the stream view and the reference; this switches its parts over.
function setPanelMode(mode) {
  const isHelp = mode === "help";
  pager.mode = mode;
  pager.list.hidden = isHelp;
  pager.sentinel.hidden = isHelp;
  pager.foot.hidden = isHelp;
  reference.page.hidden = !isHelp;
  reference.back.hidden = !isHelp;
  $("pager-title").classList.remove("plain");
  pager.body.setAttribute("aria-label", isHelp ? "Reference page" : "Stream items");
}

function showPager() {
  if (wideScreen.matches) {
    pager.el.show();
    workspace.classList.add("has-pager");
  } else {
    pager.el.showModal();
  }
}

function openPager(num, text, opener) {
  if (!ready || evalBusy) return;
  if (lost) {
    setStatus(LOST_MESSAGE, true);
    return;
  }
  if (pager.token) releasePager();
  leaveReference();
  setPanelMode("stream");
  const token = (pager.token = {});
  pager.num = num;
  pager.count = 0;
  pager.finished = false;
  pager.opener = opener ?? null;
  pager.list.replaceChildren();
  $("pager-title").textContent = `%${num}`;
  $("pager-source").textContent = text ?? "";
  pagerStatus("");

  rpc("iter_open", { num }).catch((err) => {
    if (pager.token !== token) return;
    pager.finished = true;
    pager.list.append(el("li", {}, failureNode(failureText(err))));
    pagerStatus("Could not open the stream");
  });

  if (!pager.el.open) showPager();
  pager.body.scrollTop = 0;
  pager.near = true;
  loadMore();
}

// Ends the current listing without touching the dialog.
function releasePager() {
  if (!pager.token) return;
  pager.token = null;
  pager.near = false;
  clearTimeout(pager.slowTimer);
  if (lost) return; // the iterator is gone with the module
  if (iterInflight && !evalBusy) stop();
  rpc("iter_close").catch(() => {});
}

function closePager() {
  if (pager.el.open) pager.el.close();
  workspace.classList.remove("has-pager");
  releasePager();
  leaveReference();
  pager.mode = null;
  pager.list.replaceChildren();
  const opener = pager.opener;
  pager.opener = null;
  if (opener?.isConnected) opener.focus();
  else if (!coarsePointer.matches) editor.focus();
}

function addItems(items) {
  const rows = items.map((item) => {
    if (item.type === "error") {
      return el("li", {}, failureNode(item.text, item.trace));
    }
    pager.count += 1;
    const part = `%${pager.num}[${pager.count}]`;
    const idx = el("button", { type: "button", class: "row-btn idx", title: `Insert ${part}` }, String(pager.count));
    idx.setAttribute("aria-label", `Item ${pager.count}: insert ${part}`);
    idx.dataset.insert = part;
    return el("li", {}, idx, valueNode(item.value));
  });
  pager.list.append(...rows);
}

function loadMore() {
  const token = pager.token;
  if (!token || pager.finished || iterInflight || evalBusy) return;

  // Only a wait that drags on is worth announcing; it is counted from the last item to arrive.
  let waiting = false;
  const announceWait = () => {
    waiting = true;
    pagerStatus(`${countText(pager.count)} so far, loading…`, true);
  };
  clearTimeout(pager.slowTimer);
  pager.slowTimer = setTimeout(announceWait, 300);

  const request = rpc("iter_next", { max: PAGE_SIZE }, (item) => {
    if (pager.token !== token) return;
    addItems([item]);
    if (waiting) {
      announceWait();
    } else {
      clearTimeout(pager.slowTimer);
      pager.slowTimer = setTimeout(announceWait, 300);
    }
  });
  iterInflight = request.catch(() => {});
  request.then((batch) => {
    iterInflight = null;
    if (pager.token !== token) return;
    clearTimeout(pager.slowTimer);
    if (batch.done) {
      pager.finished = true;
      pagerStatus(batch.failed ? `Stopped after ${countText(pager.count)}` : `End of stream, ${countText(pager.count)}`);
    } else {
      pagerStatus(`${countText(pager.count)} so far, scroll for more`);
      if (pager.near) loadMore();
    }
  }, (err) => {
    iterInflight = null;
    if (pager.token !== token) return;
    clearTimeout(pager.slowTimer);
    pager.finished = true;
    pager.list.append(el("li", {}, failureNode(failureText(err))));
    pagerStatus(`Stopped after ${countText(pager.count)}`);
  });
}

// Called when an evaluation ends: it may have held back the listing.
function pagerResume() {
  if (pager.token && pager.near) loadMore();
}

new IntersectionObserver((entries) => {
  pager.near = entries.at(-1).isIntersecting;
  if (pager.near) loadMore();
}, { root: pager.body, rootMargin: "400px 0px" }).observe(pager.sentinel);

$("pager-close").addEventListener("click", closePager);
pager.stopButton.addEventListener("click", requestStop);

// Esc on the modal sheet closes it natively; this catches that and any other way out.
pager.el.addEventListener("close", () => {
  if (!pager.el.open && pager.mode) closePager();
});

// A tap on the dimmed area beside the sheet closes it.
pager.el.addEventListener("click", (e) => {
  if (e.target === pager.el && pager.el.matches(":modal")) closePager();
});

pager.list.addEventListener("click", (e) => {
  const idx = e.target.closest(".idx");
  if (!idx) return;
  const modal = pager.el.matches(":modal");
  if (modal) {
    pager.opener = null;
    closePager();
  }
  insertAtCaret(idx.dataset.insert);
});

// Crossing the breakpoint with the view open: switch between the sheet and the side column.
wideScreen.addEventListener("change", () => {
  if (!pager.el.open) return;
  pager.el.close();
  workspace.classList.remove("has-pager");
  showPager();
});

// ---------- Reference ----------

const reference = {
  page: $("help-page"),
  back: $("pager-back"),
  trail: [], // the pages gone through, as { name, scroll }; the last one is on display
};

// An input starting with `?` asks for documentation instead of an evaluation.
function isHelpQuery(text) {
  return text.trimStart().startsWith("?");
}

// The page a query asks for: `?name` is a symbol, `??name` a page on the language (called
// `?name` by the package) and a bare `?` or `??` the quick guide (the empty name).
function helpName(text) {
  const sym = text.trim().slice(1).trim();
  if (!sym.startsWith("?")) return sym;
  const topic = sym.slice(1).trimStart();
  return topic === "" ? "" : `?${topic}`;
}

function refNode({ ref, text }, cls = "help-ref") {
  const link = el("button", { type: "button", class: cls }, text);
  link.dataset.help = ref;
  return link;
}

// The nodes for a line of documentation. A `plain` line is program text as a whole, so its
// parts are not marked up one by one.
function lineNodes(parts, plain = false) {
  return parts.flatMap(({ code, items }) => {
    const nodes = items.map((item) => (typeof item === "string" ? item : refNode(item)));
    return code && !plain ? [el("code", {}, ...nodes)] : nodes;
  });
}

function helpSection(title, ...content) {
  return el("section", {}, el("h3", {}, title), ...content);
}

function exampleNode(example, num) {
  const input = el("code", {}, ...lineNodes(example.input, true));
  if (example.comment) {
    input.append(el("span", { class: "comment" }, " ; ", ...lineNodes(example.comment, true)));
  }
  const output = example.failed
    ? el("div", { class: "out" }, failureNode(example.output))
    : el("div", { class: "out" }, el("span", { class: "num" }, `%${num}`), valueNode(example.output));
  return el("li", {},
    el("div", { class: "in" }, el("span", { class: "prompt", "aria-hidden": "true" }, "›"), input),
    output);
}

function renderReference(name, doc) {
  const title = $("pager-title");
  title.textContent = doc.title;
  // Pages on the language have a title in words; the others are named by their symbol.
  title.classList.toggle("plain", name === "" || name.startsWith("?"));
  $("pager-source").textContent = doc.synonyms.length > 0 ? `Also: ${doc.synonyms.join(", ")}` : "";

  const content = [];
  if (doc.usage.length > 0) {
    content.push(helpSection("Usage",
      el("ul", { class: "usage" }, ...doc.usage.map((line) => el("li", {}, el("code", {}, ...lineNodes(line, true)))))));
  }
  content.push(el("section", {},
    ...doc.desc.map(({ kind, line }) => el("p", { class: kind }, ...lineNodes(line)))));
  if (doc.examples.length > 0) {
    let num = 0;
    content.push(helpSection("Examples",
      el("ol", { class: "examples" },
        ...doc.examples.map((example) => exampleNode(example, example.failed ? num : ++num)))));
  }
  if (doc.see.length > 0) {
    content.push(helpSection("See also",
      el("ul", { class: "see" }, ...doc.see.map((ref) => el("li", {}, refNode(ref, "row-btn ref"))))));
  }
  reference.page.replaceChildren(...content);
  reference.back.disabled = reference.trail.length < 2;
}

// Shows the page `name` after the one on display, or as the first one with `restart`. Returns
// what the package says about the name; if it knows no such page, nothing changes.
function openReference(name, { restart = false, opener } = {}) {
  if (!ready) return { found: false };
  if (lost) {
    setStatus(LOST_MESSAGE, true);
    return { found: true };
  }
  const doc = help(name);
  if (!doc.found) return doc;

  if (pager.mode !== "help") {
    if (pager.token) releasePager();
    pager.list.replaceChildren();
    pager.opener = opener ?? null;
    setPanelMode("help");
  }
  if (restart) reference.trail = [];
  const shown = reference.trail.at(-1);
  if (shown) shown.scroll = pager.body.scrollTop;
  reference.trail.push({ name, scroll: 0 });
  renderReference(name, doc);
  if (!pager.el.open) showPager();
  pager.body.scrollTop = 0;
  return doc;
}

function referenceBack() {
  if (reference.trail.length < 2 || lost) return;
  reference.trail.pop();
  const { name, scroll } = reference.trail.at(-1);
  renderReference(name, help(name));
  pager.body.scrollTop = scroll;
}

function leaveReference() {
  reference.trail = [];
  reference.page.replaceChildren();
}

reference.page.addEventListener("click", (e) => {
  const link = e.target.closest("[data-help]");
  if (!link) return;
  openReference(link.dataset.help);
  pager.body.focus(); // the link is gone
});

reference.back.addEventListener("click", () => {
  referenceBack();
  if (reference.back.disabled) pager.body.focus();
});

$("help-open").addEventListener("click", (e) => openReference("", { restart: true, opener: e.currentTarget }));

// ---------- Go ----------

updateMirror();

try {
  await start();
  updateMirror();
  if (!coarsePointer.matches) editor.focus();
} catch (err) {
  showFatal(String(err.message ?? err));
}
