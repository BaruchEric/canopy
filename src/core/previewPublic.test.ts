import { expect, test } from "bun:test";
import { parsePreviewHost, parsePreviewPublic, publicPreviewOrigin } from "./previewPublic";

test("parsePreviewPublic takes an https origin with {slot} in its host", () => {
  expect(parsePreviewPublic("https://canopy-p{slot}.beric.ca")).toBe("https://canopy-p{slot}.beric.ca");
  expect(parsePreviewPublic(" https://canopy-p{slot}.beric.ca/ ")).toBe("https://canopy-p{slot}.beric.ca");
  expect(parsePreviewPublic(undefined)).toBeNull();
  expect(parsePreviewPublic("")).toBeNull();
  // plain http would not help an https page, and one name for every slot
  // would put two apps on one origin
  expect(parsePreviewPublic("http://canopy-p{slot}.beric.ca")).toBeNull();
  expect(parsePreviewPublic("https://canopy-preview.beric.ca")).toBeNull();
  expect(parsePreviewPublic("https://canopy.beric.ca/p/{slot}")).toBeNull();
  expect(parsePreviewPublic("https://canopy-p{slot}.beric.ca:8443")).toBeNull();
});

test("publicPreviewOrigin names one slot", () => {
  expect(publicPreviewOrigin("https://canopy-p{slot}.beric.ca", 7861)).toBe("https://canopy-p7861.beric.ca");
});

test("parsePreviewHost takes a tailnet IP and nothing that names no other machine's way in", () => {
  expect(parsePreviewHost(" 100.68.139.95 ")).toBe("100.68.139.95");
  expect(parsePreviewHost("[fd7a:115c::1]")).toBe("[fd7a:115c::1]");
  expect(parsePreviewHost(undefined)).toBeNull();
  expect(parsePreviewHost("127.0.0.1")).toBeNull();
  expect(parsePreviewHost("0.0.0.0")).toBeNull();
  expect(parsePreviewHost("[::1]")).toBeNull();
  // a MagicDNS name is HSTS-preloaded, so an http frame on it never loads
  expect(parsePreviewHost("macmini-2018.tail2d2c60.ts.net")).toBeNull();
  expect(parsePreviewHost("100.68.139.95:7860")).toBeNull();
});
