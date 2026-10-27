/** One build's shell and hashed assets only. API and Library requests pass
 * untouched; no token or application state is read or held. Shared rules
 * live in src/worker.ts. Install deliberately precaches nothing. */
import { PAGE_BUILD } from "./src/build";
import { cacheName, fetchPlan, keepable, SHELL, staleCaches } from "./src/worker";

declare const self: ServiceWorkerGlobalScope;
const NAME = cacheName(PAGE_BUILD);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await Promise.all(staleCaches(await caches.keys(), NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function cached(key: Request | string): Promise<Response | undefined> {
  return caches.match(key, { cacheName: NAME }).catch(() => undefined);
}

async function keep(key: Request | string, response: Response): Promise<void> {
  if (!keepable(response)) return;
  // Cache access can fail, for example when storage is full. A successful
  // network response must still reach the page.
  await caches.open(NAME).then((cache) => cache.put(key, response.clone())).catch(() => {});
}

async function shell(request: Request): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(request);
  } catch (error) {
    const fallback = await cached(SHELL);
    if (fallback) return fallback;
    throw error;
  }
  // A direct navigation to a public binary must not replace index.html.
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "text/html") await keep(SHELL, response);
  return response;
}

async function asset(request: Request): Promise<Response> {
  const hit = await cached(request);
  if (hit) return hit;
  const response = await fetch(request);
  await keep(request, response);
  return response;
}

self.addEventListener("fetch", (event) => {
  const plan = fetchPlan(event.request, self.location.origin);
  if (plan === "pass") return;
  event.respondWith(plan === "shell" ? shell(event.request) : asset(event.request));
});
