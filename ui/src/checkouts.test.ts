import { describe, expect, test } from "bun:test";
import { split, type Reg } from "./backends";
import { cardChangedAt, joinRepos, leadOf, remoteKey } from "./checkouts";
import type { Repo } from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const sp = (id: string) => split(reg, id);
const backendOf = (id: string) => sp(id)[0];
const names = reg.names;

function repo(id: string, remotes: string[] = [], over: Partial<Repo> = {}): Repo {
  const plain = sp(id)[1];
  return { id, name: plain.slice(plain.lastIndexOf("/") + 1), path: `/x/${plain}`, group: "", source: "launch", status: null, remotes, ...over };
}

describe("remoteKey", () => {
  test("the first remote with a web page, lowercased", () => {
    expect(remoteKey(repo("a", ["mini:/Users/e/dev/a", "git@github.com:Eric-M3Max/Canopy.git"]))).toBe("github.com/eric-m3max/canopy");
  });
  test("peer remotes and a self-hosted ssh remote have none", () => {
    expect(remoteKey(repo("a", ["mac:/Users/e/dev/a", "ssh://git@forge.lan:2222/e/a.git"]))).toBeNull();
  });
});

describe("joinRepos", () => {
  test("one card for the same remote on two backends, in registry order", () => {
    const mac = repo("mac|dev/canopy", ["https://github.com/eric-M3Max/canopy"]);
    const mini = repo("dev/canopy", ["git@github.com:eric-M3Max/canopy.git"]);
    const cards = joinRepos([mac, mini], names, sp);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.key).toBe("github.com/eric-m3max/canopy");
    expect(cards[0]?.name).toBe("canopy");
    expect(cards[0]?.checkouts).toEqual([mini, mac]);
  });
  test("peer-synced checkouts without a web remote meet on their plain id", () => {
    const cards = joinRepos([repo("x", ["mac:/Users/e/dev/x"]), repo("mac|x", ["mini:/home/e/dev/x"])], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["rel:x"]);
    expect(cards[0]?.checkouts).toHaveLength(2);
  });
  test("a second checkout of one remote on one backend gets its own card", () => {
    const cards = joinRepos([repo("a", ["https://github.com/o/n"]), repo("b", ["https://github.com/o/n"])], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["github.com/o/n", "github.com/o/n#b"]);
  });
  test("a single backend's repos come out one card each, in order", () => {
    const list = [repo("b"), repo("a", ["https://github.com/o/a"]), repo("c")];
    expect(joinRepos(list, ["mini"], (id) => ["mini", id]).map((c) => c.checkouts[0])).toEqual(list);
  });
  test("a forge-only repo never joins", () => {
    const forge = repo("f", ["https://github.com/o/n"], { forge: { clonedAs: "a" } as Repo["forge"] });
    const cards = joinRepos([repo("a", ["https://github.com/o/n"]), forge], names, sp);
    expect(cards.map((c) => c.key)).toEqual(["github.com/o/n", "forge:f"]);
  });
});

describe("leadOf and cardChangedAt", () => {
  const mini = repo("a", ["https://github.com/o/a"]);
  const mac = repo("mac|a", ["https://github.com/o/a"]);
  const card = joinRepos([mini, mac], names, sp)[0]!;
  test("the preferred backend when it is online", () => {
    expect(leadOf(card, "mac", () => true, backendOf)).toBe(mac);
  });
  test("the first online one when the preferred is not", () => {
    expect(leadOf(card, "mac", (b) => b === "mini", backendOf)).toBe(mini);
    expect(leadOf(card, undefined, (b) => b === "mac", backendOf)).toBe(mac);
  });
  test("the preferred, then the first, when none is online", () => {
    expect(leadOf(card, "mac", () => false, backendOf)).toBe(mac);
    expect(leadOf(card, undefined, () => false, backendOf)).toBe(mini);
  });
  test("a card changed when its newest checkout did", () => {
    const at = (n: number) => ({ branch: "main", files: [], ahead: 0, behind: 0, lastCommit: { at: n } }) as unknown as Repo["status"];
    const c = joinRepos([{ ...mini, status: at(10) }, { ...mac, status: at(30) }], names, sp)[0]!;
    expect(cardChangedAt(c)).toBe(30);
  });
});
