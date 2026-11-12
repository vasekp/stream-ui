// A service worker for hosts that cannot send the headers which make a page cross-origin
// isolated: it adds them to every response on the way to the page. It stores nothing.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const request = e.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  e.respondWith(fetch(request).then((response) => {
    if (response.status === 0) return response; // opaque, cannot be rewritten
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
