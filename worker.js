import init, { process, get_iter, reset } from "./pkg/stream_wasm.js";

// Longest time one "iter_next" request keeps collecting items before it reports back.
const BATCH_MS = 40;

let iterator = null;

function freeIterator() {
  if (iterator) {
    iterator.free();
    iterator = null;
  }
}

const ops = {
  async init({ memory }) {
    await init(undefined, memory);
  },

  process({ input }) {
    return process(input);
  },

  iter_open({ num }) {
    freeIterator();
    iterator = get_iter(num);
  },

  // Produces up to `max` items, or as many as fit in BATCH_MS. Each one is reported as soon as
  // it exists, because the next may take forever to compute. An error item ends the listing.
  iter_next({ max }, progress) {
    if (!iterator) return { done: true };
    const deadline = performance.now() + BATCH_MS;
    for (let count = 0; count < max; count++) {
      const step = iterator.next();
      if (step.done) return { done: true };
      progress(step.value);
      if (step.value.type === "error") return { done: true, failed: true };
      if (performance.now() >= deadline) break;
    }
    return { done: false };
  },

  iter_close() {
    freeIterator();
  },

  // Starts an empty session. The iterator goes first, or it would keep its stream alive.
  reset() {
    freeIterator();
    reset();
  },
};

// Requests are handled strictly in the order they arrive, one at a time.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const { id, op, ...args } = e.data;
  queue = queue.then(async () => {
    try {
      const value = await ops[op](args, (item) => self.postMessage({ id, item }));
      self.postMessage({ id, value });
    } catch (err) {
      // The package reports its own failures as plain values. An Error object is a trap or a
      // stack overflow inside the module: it has aborted and cannot be used any more.
      self.postMessage({ id, error: String(err?.message ?? err), fatal: err instanceof Error });
    }
  });
};
