import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Repo } from "../../src/core/types";
import { runLine } from "./clirun";
import { setBase, setRegistry } from "./registry";
import { useStore } from "./store";

describe("workspace commands", () => {
  const pristine = useStore.getState();
  const realFetch = globalThis.fetch;
  const oldLocation = (globalThis as { location?: unknown }).location;
  let requests = 0;

  beforeEach(() => {
    requests = 0;
    setRegistry("a", ["a", "b"]);
    setBase("a", "");
    setBase("b", "http://b.test");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "" } });
    globalThis.fetch = (async () => {
      requests += 1;
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    useStore.setState(pristine, true);
    useStore.setState({
      home: "a",
      backendOrder: ["a", "b"],
      repos: [
        { id: "proj", name: "proj", path: "/a/proj", source: "launch", group: "", status: null },
        { id: "b|proj", name: "proj", path: "/b/proj", source: "b|launch", group: "", status: null },
      ] as Repo[],
      workspaces: [],
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (oldLocation === undefined) delete (globalThis as { location?: unknown }).location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: oldLocation });
    setRegistry("", []);
    setBase("a", "");
    setBase("b", "");
    useStore.setState(pristine, true);
  });

  test("adding a remote repo to a home workspace is refused before the API call", async () => {
    const out = await runLine("ws create team b|proj");
    const message = out.lines.flatMap((line) => line.map((seg) => seg.text)).join("");

    expect(out.ok).toBe(false);
    expect(message).toContain("home backend");
    expect(requests).toBe(0);
  });

  test("removing a remote repo from a home workspace is refused before the API call", async () => {
    const out = await runLine("ws rm team b|proj");
    const message = out.lines.flatMap((line) => line.map((seg) => seg.text)).join("");

    expect(out.ok).toBe(false);
    expect(message).toContain("home backend");
    expect(requests).toBe(0);
  });
});
