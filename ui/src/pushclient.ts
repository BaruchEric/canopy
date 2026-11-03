/** This browser's push subscription (FR-042). The device tab's switch
 * turns it on and off, the page keeps the backend's copy in step on load,
 * and a notification click the worker relays lands on the item. Browser
 * globals are read only inside the functions main and the row call, so
 * the module loads under bun test. */
import type { PushEntryView } from "../../src/core/push";
import { unb64url } from "../../src/core/webpush";
import { api } from "./api";
import { clientId, myDeviceName, myPlatform } from "./client";
import { isOpenMessage, pushTarget, type PushPermission, type PushPlace } from "./push";
import { useStore, waitingCount } from "./store";

export interface PushState {
  /** a subscribe, unsubscribe or test in flight */
  busy: boolean;
  permission: PushPermission;
  /** the home backend's key: undefined until asked, null when it has none */
  key: string | null | undefined;
  keyWhy: string | null;
  /** this browser's entry on the backend, once it answered */
  mine: PushEntryView | null;
  error: string | null;
  /** the last test push, in a line */
  tested: string | null;
}

const permissionNow = (): PushPermission => (typeof Notification === "undefined" ? "none" : Notification.permission);

let snapshot: Readonly<PushState> = Object.freeze<PushState>({ busy: false, permission: "none", key: undefined, keyWhy: null, mine: null, error: null, tested: null });
const listeners = new Set<() => void>();

function publish(patch: Partial<PushState>): void {
  snapshot = Object.freeze({ ...snapshot, ...patch });
  for (const listener of listeners) listener();
}
export const pushState = (): Readonly<PushState> => snapshot;
export function subscribePush(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const hasPush = (): boolean => typeof window !== "undefined" && "PushManager" in window && "serviceWorker" in navigator && typeof Notification !== "undefined";

/** what the row hands pushWhyNot: the browser's side from its globals,
 *  the backend's from the state */
export function pushPlace(on: boolean, s: Readonly<PushState>): PushPlace {
  return {
    on,
    secure: typeof window !== "undefined" && window.isSecureContext,
    dev: import.meta.env.DEV,
    hasPush: hasPush(),
    ios: typeof navigator !== "undefined" && myPlatform() === "ios",
    standalone: typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches,
    permission: s.permission,
    key: s.key,
    keyWhy: s.keyWhy,
    mine: s.mine,
  };
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!hasPush()) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** the backend's key and this browser's entry, into the state */
export async function refreshPush(): Promise<void> {
  try {
    const info = await api.pushKey(clientId());
    publish({ key: info.key, keyWhy: info.why ?? null, mine: info.mine ?? null, permission: permissionNow() });
  } catch (err) {
    publish({ error: words(err), permission: permissionNow() });
  }
}

/** Subscribe this browser and tell the backend; `fresh` drops the browser's
 *  current subscription first, which is what "resubscribe" means after the
 *  backend marked it stale. The permission ask has to come from a click,
 *  so the row calls this from its switch. */
export async function enablePush(fresh = false): Promise<void> {
  publish({ busy: true, error: null, tested: null });
  try {
    if (!hasPush()) return;
    let permission = permissionNow();
    if (permission === "default") permission = await Notification.requestPermission();
    publish({ permission });
    if (permission !== "granted") return;
    const reg = await registration();
    if (!reg) {
      publish({ error: "No worker is registered on this page, so there is nothing to subscribe. The installed page section says why." });
      return;
    }
    const info = await api.pushKey(clientId());
    publish({ key: info.key, keyWhy: info.why ?? null, mine: info.mine ?? null });
    if (info.key === null) return;
    let sub = await reg.pushManager.getSubscription();
    if (sub && fresh) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64url(info.key) });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("the browser's subscription has no endpoint or keys");
    const { entry } = await api.pushSubscribe({
      subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
      client: clientId(),
      device: myDeviceName(useStore.getState().settings.device),
      replace: true,
    });
    publish({ mine: entry });
  } catch (err) {
    publish({ error: words(err) });
  } finally {
    publish({ busy: false });
  }
}

/** Drop the browser's subscription and the backend's entry. */
export async function disablePush(): Promise<void> {
  publish({ busy: true, error: null, tested: null });
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
    await api.pushUnsubscribe(clientId());
    publish({ mine: null });
  } catch (err) {
    publish({ error: words(err) });
  } finally {
    publish({ busy: false });
  }
}

/** One push to every subscribed browser, this one included. */
export async function testPush(): Promise<void> {
  publish({ busy: true, error: null, tested: null });
  try {
    const r = await api.pushTest();
    const parts = [`sent to ${r.sent} browser${r.sent === 1 ? "" : "s"}`];
    if (r.failed > 0) parts.push(`${r.failed} failed`);
    if (r.gone > 0) parts.push(`${r.gone} gone`);
    publish({ tested: parts.join(", "), mine: r.entries.find((e) => e.client === clientId()) ?? snapshot.mine });
  } catch (err) {
    publish({ error: words(err) });
  } finally {
    publish({ busy: false });
  }
}

async function clearBadge(): Promise<void> {
  if (typeof navigator === "undefined" || !("clearAppBadge" in navigator)) return;
  await navigator.clearAppBadge().catch(() => {});
}

/** where a click lands: the inbox on an ask, a repo's panel, or a page */
export function openFromPush(url: string): void {
  void clearBadge();
  const target = pushTarget(url, location.origin);
  const s = useStore.getState();
  if (target.kind === "ask") s.openInbox(`ask:${target.id}`);
  else if (target.kind === "repo") {
    if (s.repos.some((r) => r.id === target.id)) s.openPanel(target.id);
  } else if (`${location.pathname}${location.search}` !== target.url) location.assign(target.url);
}

/** With the setting on, the browser's subscription has to still be there:
 *  a browser drops one when its push service rotates it or the site data
 *  is cleared, and the backend would keep pushing into the void. */
async function syncOnLoad(): Promise<void> {
  const s = useStore.getState();
  if (!s.settings.push) return;
  const reg = await registration();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await refreshPush();
    return;
  }
  s.setSetting("push", false);
  await api.pushUnsubscribe(clientId()).catch(() => {});
  publish({ mine: null, error: "The browser dropped its push subscription; turn push on again to subscribe." });
}

let started = false;

/** main calls this once: the worker's click relay, the badge, and the
 *  load-time sync once the page knows its home backend */
export function startPush(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  publish({ permission: permissionNow() });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (isOpenMessage(event.data)) openFromPush(event.data.url);
    });
  }
  // The badge counts what waits when no page is open; a page that shows
  // nothing waiting clears it.
  const clearWhenIdle = (): void => {
    if (document.hasFocus() && waitingCount(useStore.getState()) === 0) void clearBadge();
  };
  window.addEventListener("focus", clearWhenIdle);
  let synced = false;
  const onState = (s: ReturnType<typeof useStore.getState>): void => {
    if (s.loaded && !synced) {
      synced = true;
      void syncOnLoad().catch((err: unknown) => publish({ error: words(err) }));
    }
    if (s.loaded) clearWhenIdle();
  };
  onState(useStore.getState());
  useStore.subscribe(onState);
}
