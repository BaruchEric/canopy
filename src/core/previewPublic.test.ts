import { expect, test } from "bun:test";
import { parsePreviewPublic, publicPreviewOrigin } from "./previewPublic";

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
