/**
 * A preview on a simulated device (FR-050): the iOS simulators Xcode's
 * simctl knows and the Android emulators (AVDs) the SDK knows, on the
 * machine the browser sits at. Pure and browser-safe: the parsers of what
 * simctl and an AVD's config.ini say, the list's wire form in a helper's
 * registration, the address a device is sent to, and the menu's order. The
 * part that runs the tools is `emulatord.ts`. Tested in emulators.test.ts.
 */
import { EMULATOR_FORMS, EMULATOR_KINDS, type Emulator, type EmulatorForm, type EmulatorKind } from "./types";

/** at most this many devices ride in a registration */
export const EMULATORS_MAX = 40;

const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const AVD = /^\w[\w.-]{0,63}$/;

/** whether a device id is one of its kind's shape: a UDID, or an AVD name
 *  of letters, digits, dots, dashes and underscores. Nothing else may reach
 *  simctl's or the emulator's argv. */
export function emulatorIdOk(kind: EmulatorKind, id: string): boolean {
  return kind === "ios" ? UDID.test(id) : AVD.test(id);
}

const isKind = (v: unknown): v is EmulatorKind => typeof v === "string" && (EMULATOR_KINDS as readonly string[]).includes(v);
const isForm = (v: unknown): v is EmulatorForm => typeof v === "string" && (EMULATOR_FORMS as readonly string[]).includes(v);

/** a display name off the wire: plain characters, at most 80 */
// eslint-disable-next-line no-control-regex
const cleanName = (v: string): string => v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);

/** One device off the wire, or null when any field is not its shape. */
export function readEmulator(v: unknown): Emulator | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isKind(o.kind) || typeof o.id !== "string" || !emulatorIdOk(o.kind, o.id)) return null;
  if (typeof o.name !== "string" || !isForm(o.form)) return null;
  const name = cleanName(o.name) || o.id;
  return { kind: o.kind, id: o.id, name, form: o.form, ...(o.running === true ? { running: true } : {}) };
}

/** The `emulators=` value of a helper's registration: the list as JSON. */
export function emulatorsParam(list: readonly Emulator[]): string {
  return JSON.stringify(list.slice(0, EMULATORS_MAX));
}

/** The list out of a registration's `emulators=`. A malformed value is
 *  an empty list, and a device that is not its shape is left out, so a
 *  newer helper's kinds pass over an older backend without refusing it. */
export function parseEmulatorsParam(raw: string | null): Emulator[] | undefined {
  if (raw === null) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: Emulator[] = [];
  for (const item of v.slice(0, EMULATORS_MAX)) {
    const e = readEmulator(item);
    if (e && !out.some((x) => x.kind === e.kind && x.id === e.id)) out.push(e);
  }
  return out;
}

/** `iOS-26-5` out of a runtime identifier, as "iOS 26.5"; null for any
 *  runtime that is not iOS (watchOS, tvOS, visionOS have no page to show) */
function iosRuntime(runtime: string): string | null {
  const m = /SimRuntime\.iOS-(\d+)(?:-(\d+))?(?:-(\d+))?$/.exec(runtime);
  if (!m) return null;
  return `iOS ${[m[1], m[2], m[3]].filter((x) => x !== undefined).join(".")}`;
}

/** The iOS simulators in `xcrun simctl list devices available -j`: an
 *  iPhone is a phone, an iPad a tablet, the newest runtime first. */
export function parseSimctl(json: string): Emulator[] {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  const devices = (v as { devices?: unknown } | null)?.devices;
  if (typeof devices !== "object" || devices === null) return [];
  const runtimes = Object.entries(devices as Record<string, unknown>)
    .map(([runtime, list]) => ({ label: iosRuntime(runtime), list, order: runtime }))
    .filter((r): r is { label: string; list: unknown; order: string } => r.label !== null && Array.isArray(r.list))
    .sort((a, b) => b.order.localeCompare(a.order, "en", { numeric: true }));
  const out: Emulator[] = [];
  for (const r of runtimes) {
    for (const d of r.list as unknown[]) {
      if (typeof d !== "object" || d === null) continue;
      const o = d as Record<string, unknown>;
      if (typeof o.udid !== "string" || !UDID.test(o.udid) || typeof o.name !== "string") continue;
      if (o.isAvailable === false) continue;
      const type = typeof o.deviceTypeIdentifier === "string" ? o.deviceTypeIdentifier : o.name;
      const form: EmulatorForm = /iPad/i.test(type) ? "tablet" : /iPhone/i.test(type) ? "phone" : "other";
      out.push({
        kind: "ios",
        id: o.udid,
        name: cleanName(`${o.name} · ${r.label}`),
        form,
        ...(o.state === "Booted" ? { running: true } : {}),
      });
    }
  }
  return out;
}

/** `key=value` lines, as an AVD's config.ini and its pointer .ini hold */
export function parseIni(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0 || line.trimStart().startsWith("#")) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** What an AVD is shaped like by its config.ini: a watch, TV, car or
 *  glasses image is "other"; otherwise its screen's short side in dp, 600
 *  and up being a tablet, the line Android's own layouts draw. */
export function avdForm(config: Record<string, string>): EmulatorForm {
  const tags = `${config["tag.id"] ?? ""},${config["tag.ids"] ?? ""}`;
  if (/wear|android-tv|google-tv|automotive|glasses|\bxr\b/i.test(tags.replace(/ai_glasses_compatible/g, ""))) return "other";
  const w = Number(config["hw.lcd.width"]);
  const h = Number(config["hw.lcd.height"]);
  const density = Number(config["hw.lcd.density"]) || 160;
  if (!(w > 0 && h > 0)) return "phone";
  return (Math.min(w, h) * 160) / density >= 600 ? "tablet" : "phone";
}

/** "pixel_9_pro" as "Pixel 9 Pro" */
const deviceWords = (raw: string): string =>
  raw
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 2 && /\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");

/** One AVD by its name and config.ini, or null for a name not its shape. */
export function avdEmulator(name: string, config: Record<string, string>, running = false): Emulator | null {
  if (!AVD.test(name)) return null;
  const device = config["hw.device.name"];
  const label = config["avd.ini.displayname"] || (device ? `${deviceWords(device)} (${name})` : name);
  return { kind: "android", id: name, name: cleanName(label) || name, form: avdForm(config), ...(running ? { running: true } : {}) };
}

/** The serials of the emulators `adb devices` lists as up ("device");
 *  `adb -s <serial> emu avd name` then says which AVD each one is. */
export function parseAdbDevices(out: string): string[] {
  const serials: string[] = [];
  for (const line of out.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && /^emulator-\d+$/.test(serial) && state === "device") serials.push(serial);
  }
  return serials;
}

/** whether an address is the machine's own loopback, which an Android
 *  emulator reaches only through `adb reverse` */
export function loopbackUrl(url: string): number | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return null;
  const port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** An address a device may be sent to: http or https, nothing else, at
 *  most 2000 characters; null otherwise. */
export function emulatorUrlOk(url: string): string | null {
  if (url.length > 2000) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Where a device is sent for a dev server on `port` at `path`: the dev
 *  server itself when the machine starting the device is the backend's
 *  (`local`), else the backend's preview slot at its tailnet address, the
 *  one an http page frames. The slot's public https name sits behind the
 *  gate, whose sign-in a fresh simulator has never done, so it is not used.
 *  An error says what is missing. */
export function emulatorTarget(
  where: { local: true } | { local: false; host: string | null; slot: number | null },
  port: number,
  path: string,
): string | { error: string } {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (where.local) return `http://localhost:${port}${p}`;
  if (!where.host) return { error: "the backend has no CANOPY_PREVIEW_HOST, so another machine's simulator cannot reach its dev servers" };
  if (where.slot === null) return { error: "no preview port could be opened for that dev server" };
  const host = where.host.includes(":") ? `[${where.host}]` : where.host;
  return `http://${host}:${where.slot}${p}`;
}

/** The menu's order for a page shown as `form`: that form first, running
 *  ones first within it, iOS before Android, then the rest the same way;
 *  "other" devices last. */
export function emulatorOrder(list: readonly Emulator[], form: EmulatorForm | null): Emulator[] {
  const rank = (e: Emulator) =>
    (e.form === form ? 0 : e.form === "other" ? 2 : 1) * 4 + (e.running ? 0 : 2) + (e.kind === "ios" ? 0 : 1);
  return list
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map((x) => x.e);
}

/** a device's menu key, its kind and id */
export const emulatorKey = (e: Pick<Emulator, "kind" | "id">): string => `${e.kind}:${e.id}`;

/** a menu key back into a kind and an id, or null */
export function readEmulatorKey(key: string): { kind: EmulatorKind; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0) return null;
  const kind = key.slice(0, i);
  const id = key.slice(i + 1);
  return isKind(kind) && emulatorIdOk(kind, id) ? { kind, id } : null;
}
