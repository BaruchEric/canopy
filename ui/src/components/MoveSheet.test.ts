import { expect, test } from "bun:test";
import type { TermInfo } from "../../../src/core/types";
import { landOnce } from "./MoveSheet";

test("a moved tab lands once, however many ways the sheet tries", () => {
  const seen: string[] = [];
  const land = landOnce((info) => seen.push(info.id));
  const info: TermInfo = { id: "beta|t1", repoId: "beta|demo", path: "/dev/demo", place: "panel", attached: false, viewers: [], startedAt: 1 };
  land(info);
  land(info);
  land({ ...info, id: "beta|t2" });
  expect(seen).toEqual(["beta|t1"]);
});
