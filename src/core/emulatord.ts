/**
 * Starting a simulated device and opening a page in it (FR-050), on the
 * machine this process runs on: the helper's, or a Mac backend's own when
 * the browser is on it. iOS goes through Xcode's `xcrun simctl`, Android
 * through the SDK's `emulator` and `adb`. Bun-only; what the tools say is
 * read by the pure `emulators.ts`.
 *
 * A launchd job's PATH is short, so the tools are looked for where Xcode
 * and the Android SDK put them as well as on PATH. Every call has a
 * timeout: simctl's first run after an Xcode update migrates CoreSimulator
 * and can sit for minutes.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { avdEmulator, emulatorIdOk, emulatorUrlOk, loopbackUrl, parseAdbDevices, parseIni, parseSimctl } from "./emulators";
import { exec } from "./exec";
import { shellQuote } from "./host";
import type { Emulator, EmulatorKind } from "./types";

/** how long listing the devices may take, per kind */
export const LIST_TIMEOUT = 10_000;
/** how long a device may take to boot before the open is called failed */
export const BOOT_TIMEOUT = 180_000;
/** how long the caller waits for the page to be open before it is told the
 *  device is still starting; the rest goes on without it. A helper's
 *  answer rides a request that a tunnel cuts at 100 s. */
export const ANSWER_BY = 40_000;

const home = homedir();

function firstThere(paths: (string | undefined)[]): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

/** the Android SDK's folder: the environment's, else where Android Studio puts it */
function androidSdk(): string | null {
  return firstThere([
    process.env["ANDROID_HOME"],
    process.env["ANDROID_SDK_ROOT"],
    process.platform === "darwin" ? join(home, "Library/Android/sdk") : join(home, "Android/Sdk"),
  ]);
}

function sdkTool(sub: string, name: string): string | null {
  const sdk = androidSdk();
  return firstThere([sdk ? join(sdk, sub, name) : undefined]) ?? Bun.which(name);
}

const adbBin = (): string | null => sdkTool("platform-tools", "adb");
const emulatorBin = (): string | null => sdkTool("emulator", "emulator");
const xcrunBin = (): string | null =>
  process.platform === "darwin" ? (Bun.which("xcrun") ?? firstThere(["/usr/bin/xcrun"])) : null;

/** where the AVDs live, by the emulator's own rules */
function avdHome(): string {
  const own = process.env["ANDROID_AVD_HOME"];
  if (own) return own;
  const user = process.env["ANDROID_USER_HOME"];
  return join(user || join(home, ".android"), "avd");
}

async function iosDevices(): Promise<Emulator[]> {
  const xcrun = xcrunBin();
  if (!xcrun) return [];
  const r = await exec([xcrun, "simctl", "list", "devices", "available", "-j"], { timeoutMs: LIST_TIMEOUT });
  return r.code === 0 ? parseSimctl(r.stdout) : [];
}

/** the running emulators' serials by AVD name */
async function runningAvds(adb: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await exec([adb, "devices"], { timeoutMs: 5_000 });
  if (r.code !== 0) return out;
  for (const serial of parseAdbDevices(r.stdout)) {
    const n = await exec([adb, "-s", serial, "emu", "avd", "name"], { timeoutMs: 3_000 });
    const name = n.stdout.split("\n")[0]?.trim();
    if (n.code === 0 && name) out.set(name, serial);
  }
  return out;
}

async function androidDevices(): Promise<Emulator[]> {
  if (!emulatorBin()) return [];
  const dir = avdHome();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith(".ini")).map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
  const adb = adbBin();
  const running = adb ? await runningAvds(adb) : new Map<string, string>();
  const out: Emulator[] = [];
  for (const name of names.sort()) {
    const pointer = parseIni(await readFile(join(dir, `${name}.ini`), "utf8").catch(() => ""));
    const folder = pointer["path"] || join(dir, `${name}.avd`);
    const config = parseIni(await readFile(join(folder, "config.ini"), "utf8").catch(() => ""));
    const e = avdEmulator(name, config, running.has(name));
    if (e) out.push(e);
  }
  return out;
}

/** Every simulator and emulator this machine can start a page in: none on
 *  a machine without Xcode or the Android SDK, and none of a kind whose
 *  tool did not answer in time. */
export async function localEmulators(): Promise<Emulator[]> {
  const [ios, android] = await Promise.all([iosDevices().catch(() => []), androidDevices().catch(() => [])]);
  return [...ios, ...android];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const failed = (what: string, r: { stderr: string; stdout: string }): Error =>
  new Error(`${what}: ${(r.stderr.trim() || r.stdout.trim()).split("\n")[0] || "no answer"}`);

/** The app that shows a booted simulator: Simulator.app up to Xcode 26,
 *  DeviceHub from Xcode 27, which dropped Simulator.app. */
const SIMULATOR_APPS = ["com.apple.iphonesimulator", "com.apple.dt.Devices"];

async function openIos(id: string, url: string): Promise<void> {
  const xcrun = xcrunBin();
  if (!xcrun) throw new Error("Xcode's xcrun is not here");
  // bootstatus -b boots the device when it is down and returns once it is
  // ready for a URL; the app only shows it, so it comes after
  const boot = await exec([xcrun, "simctl", "bootstatus", id, "-b"], { timeoutMs: BOOT_TIMEOUT });
  if (boot.code !== 0) throw failed("the simulator did not boot", boot);
  let shown = false;
  for (const bundle of SIMULATOR_APPS) {
    const app = await exec(["open", "-b", bundle, "--args", "-CurrentDeviceUDID", id], { timeoutMs: 15_000 });
    if (app.code === 0) {
      shown = true;
      break;
    }
  }
  const open = await exec([xcrun, "simctl", "openurl", id, url], { timeoutMs: 30_000 });
  if (open.code !== 0) throw failed("the simulator did not open the page", open);
  if (!shown) throw new Error("the page is open in the simulator, but neither Simulator nor DeviceHub opened to show it");
}

async function openAndroid(id: string, url: string): Promise<void> {
  const adb = adbBin();
  const emulator = emulatorBin();
  if (!adb || !emulator) throw new Error("the Android SDK's adb and emulator are not here");
  let serial = (await runningAvds(adb)).get(id) ?? null;
  const until = Date.now() + BOOT_TIMEOUT;
  if (serial === null) {
    // the emulator outlives this call and this process: its own group, no pipes
    const proc = Bun.spawn([emulator, "-avd", id], { stdio: ["ignore", "ignore", "ignore"], detached: true });
    proc.unref();
    while (serial === null) {
      if (Date.now() > until) throw new Error(`the emulator ${id} did not come up in time`);
      if (proc.exitCode !== null && proc.exitCode !== 0) throw new Error(`the emulator ${id} exited with ${proc.exitCode}`);
      await sleep(1_000);
      serial = (await runningAvds(adb)).get(id) ?? null;
    }
  }
  for (;;) {
    const r = await exec([adb, "-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 5_000 });
    if (r.code === 0 && r.stdout.trim() === "1") break;
    if (Date.now() > until) throw new Error(`the emulator ${id} did not finish booting in time`);
    await sleep(1_000);
  }
  // the machine's own loopback is the emulator's own inside it; reverse
  // hands that port back to this machine, so the page stays on localhost
  const port = loopbackUrl(url);
  if (port !== null) {
    const rev = await exec([adb, "-s", serial, "reverse", `tcp:${port}`, `tcp:${port}`], { timeoutMs: 10_000 });
    if (rev.code !== 0) throw failed("adb reverse failed", rev);
  }
  // adb shell joins its arguments into one line for the device's sh
  const view = await exec([adb, "-s", serial, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shellQuote(url)], { timeoutMs: 20_000 });
  if (view.code !== 0 || /Error:/.test(view.stdout)) throw failed("the emulator did not open the page", view);
}

/** Start the device `id` of `kind` and open `url` in it. The id must be one
 *  this machine lists now, so a name off the wire never reaches a command
 *  line unless it is a device here. Resolves once the page is open, or at
 *  `answerBy` with a note that it is still starting, the rest going on in
 *  the background and its failure going to `log`. */
export async function openInEmulator(
  kind: EmulatorKind,
  id: string,
  url: string,
  opts: { answerBy?: number; log?: (line: string) => void; list?: () => Promise<Emulator[]> } = {},
): Promise<string | undefined> {
  if (!emulatorIdOk(kind, id)) throw new Error("that is not a simulator or emulator id");
  const href = emulatorUrlOk(url);
  if (!href) throw new Error("only an http or https address opens in a simulator");
  const device = (await (opts.list ?? localEmulators)()).find((e) => e.kind === kind && e.id === id);
  if (!device) throw new Error(`no ${kind === "ios" ? "iOS simulator" : "Android emulator"} ${id} here`);
  const work = kind === "ios" ? openIos(id, href) : openAndroid(id, href);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((r) => {
    timer = setTimeout(() => r("late"), opts.answerBy ?? ANSWER_BY);
  });
  try {
    if ((await Promise.race([work.then(() => "done" as const), late])) === "done") return undefined;
  } finally {
    clearTimeout(timer);
  }
  work.then(
    () => opts.log?.(`opened ${href} in ${device.name}`),
    (e: unknown) => opts.log?.(`could not open ${href} in ${device.name}: ${e instanceof Error ? e.message : String(e)}`),
  );
  return `${device.name} is still starting; the page opens once it has booted`;
}
