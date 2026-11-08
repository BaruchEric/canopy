/** One build's shell and hashed assets only. API and Library requests pass
 * untouched; no token or application state is read or held, save a share
 * from the share sheet until the page takes it. Shared rules live in
 * src/worker.ts, the share's in src/sharetarget.ts and the push words in
 * src/push.ts. Install deliberately precaches nothing. */
import { PAGE_BUILD } from "./src/build";
import { cacheName, fetchPlan, keepable, SHELL, staleCaches } from "./src/worker";
import { shareCache, shareId, staleShares, SHARE_FAILED, SHARE_FILE, SHARE_META, type ShareMeta } from "./src/sharetarget";
import { notificationUrl, OPEN_MESSAGE, parsePushPayload, pickClient, type OpenMessage } from "./src/push";

declare const self: ServiceWorkerGlobalScope;
const NAME = cacheName(PAGE_BUILD);

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all([...staleCaches(names, NAME), ...staleShares(names, Date.now())].map((name) => caches.delete(name)));
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

// The share sheet (the manifest's share_target). The form waits in a cache
// of its own until the page, signed in with its own token, takes it; the
// worker only holds it and sends the window on.
async function share(request: Request): Promise<Response> {
  const id = shareId(Date.now(), crypto.randomUUID().replace(/-/g, "").slice(0, 8));
  const name = shareCache(id);
  const go = (value: string) => Response.redirect(new URL(`/?share=${value}`, self.location.origin).href, 303);
  try {
    const form = await request.formData();
    const word = (key: string): string => {
      const v = form.get(key);
      return typeof v === "string" ? v : "";
    };
    const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
    const meta: ShareMeta = { title: word("title"), text: word("text"), url: word("url"), files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })) };
    const cache = await caches.open(name);
    await Promise.all(files.map((f, i) => cache.put(`${SHARE_FILE}${i}`, new Response(f, { headers: { "content-type": f.type || "application/octet-stream" } }))));
    await cache.put(SHARE_META, new Response(JSON.stringify(meta), { headers: { "content-type": "application/json" } }));
    // shares an earlier window never took
    await Promise.all(staleShares(await caches.keys(), Date.now()).map((n) => caches.delete(n))).catch(() => {});
    return go(id);
  } catch {
    await caches.delete(name).catch(() => false);
    return go(SHARE_FAILED);
  }
}

self.addEventListener("fetch", (event) => {
  const plan = fetchPlan(event.request, self.location.origin);
  if (plan === "pass") return;
  event.respondWith(plan === "shell" ? shell(event.request) : plan === "share" ? share(event.request) : asset(event.request));
});

// Web push (FR-042). A push shows what the backend sent, nothing more; the
// payload is a title, a line and a path on this origin, never a token. The
// badge is the payload's count of what waits. A click goes to a window of
// ours when one is open, which lands on the item itself, else opens one on
// the item's link.
async function setBadge(count: number): Promise<void> {
  if (!("setAppBadge" in self.navigator)) return;
  await (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge()).catch(() => {});
}

self.addEventListener("push", (event) => {
  const payload = parsePushPayload(event.data?.text() ?? null);
  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title, { body: payload.body, tag: payload.key, data: { url: payload.url }, icon: "/icons/canopy-192.png" });
    await setBadge(payload.count);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = notificationUrl(event.notification.data);
  event.waitUntil((async () => {
    await setBadge(0);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = windows[pickClient(windows.map((w) => ({ url: w.url, focused: w.focused })), self.location.origin)];
    if (client) {
      await client.focus().catch(() => {});
      client.postMessage({ type: OPEN_MESSAGE, url } satisfies OpenMessage);
      return;
    }
    await self.clients.openWindow(url);
  })());
});
