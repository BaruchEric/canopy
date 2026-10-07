import { expect, test } from "bun:test";
import { oneMenu } from "./menus";

test("opening a menu closes the one already open, and a closed one is let go", () => {
  const closed: string[] = [];
  const releaseA = oneMenu(() => closed.push("a"));
  const releaseB = oneMenu(() => closed.push("b"));
  expect(closed).toEqual(["a"]);
  // a's own close comes late, after b took over: it lets go of nothing
  releaseA();
  releaseB();
  oneMenu(() => closed.push("c"));
  expect(closed).toEqual(["a"]);
});
