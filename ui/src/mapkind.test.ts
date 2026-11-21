import { expect, test } from "bun:test";
import { parseMapKinds, withMapKind } from "./mapkind";

test("parseMapKinds keeps only real choices", () => {
  expect(parseMapKinds(null)).toEqual({});
  expect(parseMapKinds("not json")).toEqual({});
  expect(parseMapKinds("[1]")).toEqual({});
  expect(parseMapKinds('{"a":"archify","b":"floorplan","c":"other","d":3,"e":"understand"}')).toEqual({ a: "archify", b: "floorplan", e: "understand" });
});

test("withMapKind keeps a repo's choice last and drops the default", () => {
  expect(withMapKind({ a: "archify", b: "archify" }, "a", "archify")).toEqual({ b: "archify", a: "archify" });
  expect(Object.keys(withMapKind({ a: "archify", b: "archify" }, "a", "archify"))).toEqual(["b", "a"]);
  expect(withMapKind({ a: "archify" }, "a", "floorplan")).toEqual({});
  const many = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`r${i}`, "archify" as const]));
  const kept = withMapKind(many, "new", "archify");
  expect(Object.keys(kept)).toHaveLength(200);
  expect(kept["new"]).toBe("archify");
  expect(kept["r0"]).toBeUndefined();
});
