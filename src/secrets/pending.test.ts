import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPending, writePending, type KeptProposal } from "./pending";

const AGE = "-----BEGIN AGE ENCRYPTED FILE-----\nfixture\n-----END AGE ENCRYPTED FILE-----\n";
const one = (id: string, key: string, over: Partial<KeptProposal["p"]> = {}): KeptProposal => ({
  id,
  p: { from: "mac", source: "/Users/e/dev/.env", key, sealed: AGE, merges: null, ...over },
  expires: 1_800_000_000_000,
});

let dir = "";
let file = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-pending-"));
  file = join(dir, "proposals.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the kept proposals file", () => {
  test("comes back as it was written, at 0600, with no temp file left beside it", async () => {
    const list = [one("a1", "A"), one("b2", "B", { partial: true }), one("c3", "C", { sealed: "", merges: "c_key" })];
    await writePending(file, list);
    expect(await readPending(file)).toEqual({ list, dropped: 0 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(["proposals.json"]);
    await writePending(file, []);
    expect(await readPending(file)).toEqual({ list: [], dropped: 0 });
  });

  test("no file is no proposals and nothing lost", async () => {
    expect(await readPending(file)).toEqual({ list: [], dropped: 0 });
  });

  test("a file that is not a JSON list counts as one lost, and a folder in its place too", async () => {
    await writeFile(file, "{ torn");
    expect(await readPending(file)).toEqual({ list: [], dropped: 1 });
    await writeFile(file, '{"id":"a1"}');
    expect(await readPending(file)).toEqual({ list: [], dropped: 1 });
    expect(await readPending(dir)).toEqual({ list: [], dropped: 1 });
  });

  test("an entry that would not pass as a new proposal is left out and counted", async () => {
    const good = one("a1", "A");
    const bad: unknown[] = [
      { ...good, id: "has space" },
      { ...good, id: "b2", expires: "soon" },
      { ...good, id: "c3", p: { ...good.p, source: "relative/.env" } },
      { ...good, id: "d4", p: { ...good.p, sealed: "plain text, not sealed" } },
      { ...good, id: "e5", p: { ...good.p, from: "../mac" } },
      "a string",
      null,
    ];
    await writeFile(file, JSON.stringify([good, ...bad]));
    expect(await readPending(file)).toEqual({ list: [good], dropped: bad.length });
  });

  test("a field the service does not keep is dropped on the way in", async () => {
    await writeFile(file, JSON.stringify([{ ...one("a1", "A"), same: "cf_token", extra: 1 }]));
    expect((await readPending(file)).list).toEqual([one("a1", "A")]);
  });
});
