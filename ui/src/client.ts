/**
 * This browser's identity on the backend: an id it makes once and keeps in
 * localStorage (so every window of one profile is one device), and a name,
 * the user's from settings or a guess off the user agent. Sent on the event
 * stream and the shell sockets, so presence and a shell's viewers can say
 * which device is which behind a proxy that gives them all one address.
 */
import { deviceName, newClientId, platformOf } from "../../src/core/presence";
import type { DevicePlatform } from "../../src/core/types";

const KEY = "canopy.client";

let cached: string | null = null;

/** the id, made on first use and kept; per page when storage is off */
export function clientId(): string {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[0-9a-f]{16}$/.test(saved)) return (cached = saved);
    const fresh = newClientId();
    localStorage.setItem(KEY, fresh);
    return (cached = fresh);
  } catch {
    return (cached = newClientId());
  }
}

/** the name this browser registers under: settings first, else the guess */
export function myDeviceName(device: string): string {
  const named = device.trim();
  return named || deviceName(navigator.userAgent);
}

export const myPlatform = (): DevicePlatform => platformOf(navigator.userAgent);

/** the query a stream or a socket carries to say which device it is */
export function identity(device: string): Record<string, string> {
  return { client: clientId(), name: myDeviceName(device), platform: myPlatform() };
}
