import { expect, test } from "bun:test";
import { onSaid, saidNow, say } from "./said";

test("say keeps the latest word, each with an id of its own, and tells whoever listens", () => {
  const heard: string[] = [];
  const off = onSaid(() => heard.push(saidNow()?.text ?? ""));
  const a = say("copied branch: main");
  const b = say("copied branch: main");
  expect(saidNow()).toEqual(b);
  expect(b.id).toBeGreaterThan(a.id);
  expect(a.bad).toBe(false);
  expect(say("could not copy", true).bad).toBe(true);
  expect(heard).toEqual(["copied branch: main", "copied branch: main", "could not copy"]);
  off();
  say("after");
  expect(heard).toHaveLength(3);
  expect(saidNow()?.text).toBe("after");
});
