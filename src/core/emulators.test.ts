import { describe, expect, test } from "bun:test";
import {
  avdEmulator,
  avdForm,
  emulatorIdOk,
  emulatorKey,
  emulatorOrder,
  emulatorsParam,
  emulatorTarget,
  emulatorUrlOk,
  loopbackUrl,
  parseAdbDevices,
  parseEmulatorsParam,
  parseIni,
  parseSimctl,
  readEmulatorKey,
} from "./emulators";
import type { Emulator } from "./types";

const PHONE = "1A627B96-6489-42B5-B90F-8DF99F59A631";
const PAD = "2B738C07-7590-43C6-C01F-9EF00F60B742";

describe("parseSimctl", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-2": [
        { udid: PAD, name: "iPad Air 11-inch (M3)", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M3" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
        { udid: PHONE, name: "iPhone 17", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" },
        { udid: "not-a-udid", name: "Broken", state: "Shutdown" },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-0": [
        { udid: "3C849D18-8601-44D7-D12A-AF011A71C853", name: "Apple Watch", state: "Shutdown" },
      ],
    },
  });

  test("iPhones are phones and iPads tablets, newest runtime first, watches left out", () => {
    expect(parseSimctl(json)).toEqual([
      { kind: "ios", id: PHONE, name: "iPhone 17 · iOS 26.5", form: "phone", running: true },
      { kind: "ios", id: PAD, name: "iPad Air 11-inch (M3) · iOS 18.2", form: "tablet" },
    ]);
  });

  test("anything that is not simctl's json is no devices", () => {
    expect(parseSimctl("Install Started\n")).toEqual([]);
    expect(parseSimctl("{}")).toEqual([]);
  });
});

describe("AVDs", () => {
  const pixel = parseIni("hw.device.name=pixel_7\nhw.lcd.density=420\nhw.lcd.height=2400\nhw.lcd.width=1080\ntag.id=google_apis\n");

  test("a phone's short side is under 600dp, a tablet's at or over it", () => {
    expect(avdForm(pixel)).toBe("phone");
    expect(avdForm({ "hw.lcd.width": "1600", "hw.lcd.height": "2560", "hw.lcd.density": "320" })).toBe("tablet");
    expect(avdForm({ "hw.lcd.width": "320", "hw.lcd.height": "640", "hw.lcd.density": "160" })).toBe("phone");
  });

  test("a watch, TV or glasses image is other; a phone that pairs with glasses is still a phone", () => {
    expect(avdForm({ "tag.id": "ai-glasses", "hw.lcd.width": "450", "hw.lcd.height": "450" })).toBe("other");
    expect(avdForm({ "tag.id": "android-wear" })).toBe("other");
    expect(avdForm({ ...pixel, "tag.ids": "google_apis_playstore,page_size_16kb,ai_glasses_compatible" })).toBe("phone");
  });

  test("named by its device and AVD; a name not its shape is left out", () => {
    expect(avdEmulator("privatelm", pixel, true)).toEqual({ kind: "android", id: "privatelm", name: "Pixel 7 (privatelm)", form: "phone", running: true });
    expect(avdEmulator("bare", {})).toEqual({ kind: "android", id: "bare", name: "bare", form: "phone" });
    expect(avdEmulator("a b;rm", pixel)).toBeNull();
  });

  test("adb devices: the emulators that are up", () => {
    const out = "List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58N123\tdevice\n\n";
    expect(parseAdbDevices(out)).toEqual(["emulator-5554"]);
  });
});

describe("the wire", () => {
  const list: Emulator[] = [
    { kind: "ios", id: PHONE, name: "iPhone 17 · iOS 26.5", form: "phone", running: true },
    { kind: "android", id: "privatelm", name: "Pixel 7 (privatelm)", form: "phone" },
  ];

  test("the list rides a registration and reads back the same", () => {
    expect(parseEmulatorsParam(emulatorsParam(list))).toEqual(list);
    expect(parseEmulatorsParam(null)).toBeUndefined();
  });

  test("garbage is an empty list, and a device not its shape is dropped", () => {
    expect(parseEmulatorsParam("not json")).toEqual([]);
    expect(parseEmulatorsParam('{"a":1}')).toEqual([]);
    const mixed = JSON.stringify([
      list[0],
      { kind: "ios", id: "x; rm -rf /", name: "bad", form: "phone" },
      { kind: "winphone", id: "a", name: "a", form: "phone" },
      { kind: "android", id: "privatelm", name: "Pixel\u0007 7", form: "phone" },
      list[0],
    ]);
    expect(parseEmulatorsParam(mixed)).toEqual([list[0]!, { kind: "android", id: "privatelm", name: "Pixel 7", form: "phone" }]);
  });

  test("ids: a UDID for iOS, a plain AVD name for Android", () => {
    expect(emulatorIdOk("ios", PHONE)).toBe(true);
    expect(emulatorIdOk("ios", "privatelm")).toBe(false);
    expect(emulatorIdOk("android", "Pixel_7_API_35")).toBe(true);
    expect(emulatorIdOk("android", "-wipe-data")).toBe(false);
    expect(emulatorIdOk("android", "a/b")).toBe(false);
  });

  test("a menu key goes there and back, and a bad one is null", () => {
    expect(readEmulatorKey(emulatorKey(list[0]!))).toEqual({ kind: "ios", id: PHONE });
    expect(readEmulatorKey("android:privatelm")).toEqual({ kind: "android", id: "privatelm" });
    expect(readEmulatorKey("ios:nope")).toBeNull();
    expect(readEmulatorKey("")).toBeNull();
  });
});

describe("where the device is sent", () => {
  test("the dev server itself on the backend's own machine, the slot at its tailnet address elsewhere", () => {
    expect(emulatorTarget({ local: true }, 5173, "/app?x=1")).toBe("http://localhost:5173/app?x=1");
    expect(emulatorTarget({ local: false, host: "100.68.139.95", slot: 7861 }, 5173, "app")).toBe("http://100.68.139.95:7861/app");
    expect(emulatorTarget({ local: false, host: "fd7a::1", slot: 7861 }, 5173, "/")).toBe("http://[fd7a::1]:7861/");
  });

  test("says what is missing", () => {
    expect(emulatorTarget({ local: false, host: null, slot: 7861 }, 5173, "/")).toHaveProperty("error");
    expect(emulatorTarget({ local: false, host: "100.1.2.3", slot: null }, 5173, "/")).toHaveProperty("error");
  });

  test("only http and https addresses; loopback ones say their port for adb reverse", () => {
    expect(emulatorUrlOk("http://localhost:5173/a")).toBe("http://localhost:5173/a");
    expect(emulatorUrlOk("javascript:alert(1)")).toBeNull();
    expect(emulatorUrlOk("file:///etc/passwd")).toBeNull();
    expect(emulatorUrlOk(`http://a/${"x".repeat(2001)}`)).toBeNull();
    expect(loopbackUrl("http://localhost:5173/")).toBe(5173);
    expect(loopbackUrl("http://127.0.0.1/")).toBe(80);
    expect(loopbackUrl("http://100.68.139.95:7861/")).toBeNull();
  });
});

describe("emulatorOrder", () => {
  const ipad: Emulator = { kind: "ios", id: PAD, name: "iPad", form: "tablet" };
  const iphone: Emulator = { kind: "ios", id: PHONE, name: "iPhone", form: "phone" };
  const pixel: Emulator = { kind: "android", id: "p", name: "Pixel", form: "phone", running: true };
  const glasses: Emulator = { kind: "android", id: "g", name: "Glasses", form: "other" };

  test("the page's form first, running ones first in it, other devices last", () => {
    expect(emulatorOrder([glasses, ipad, iphone, pixel], "phone").map((e) => e.name)).toEqual(["Pixel", "iPhone", "iPad", "Glasses"]);
    expect(emulatorOrder([glasses, ipad, iphone, pixel], "tablet").map((e) => e.name)).toEqual(["iPad", "Pixel", "iPhone", "Glasses"]);
    expect(emulatorOrder([glasses, ipad, iphone], null).map((e) => e.name)).toEqual(["iPad", "iPhone", "Glasses"]);
  });
});
