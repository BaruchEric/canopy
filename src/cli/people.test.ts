import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PeopleInfo, PersonHere } from "../core/people";
import { startServer } from "../server/index";
import { statusWords } from "./auth";
import { activityLines, inviteWords, peopleLines, rosterOf, takeAll, teamLines } from "./people";

const here = (over: Partial<PersonHere> & Pick<PersonHere, "id" | "name" | "role">): PersonHere => ({ teams: [], created: 1, devices: [], at: [], invited: 0, ...over });

const info: PeopleInfo = {
  people: [
    here({ id: "owner", name: "Eric", role: "owner", devices: [{ id: "a", name: "Mac", platform: "mac" }] }),
    here({ id: "p-aaaaaaaa", name: "Avery", role: "member", teams: ["t-aaaaaaaa"], invited: 2 }),
    here({ id: "p-bbbbbbbb", name: "Guest", role: "viewer", off: true }),
  ],
  teams: [
    { id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio"], created: 1 },
    { id: "t-bbbbbbbb", name: "Empty", folders: [], created: 1 },
  ],
};

describe("what canopy people prints", () => {
  test("a line a person: id, name, role, teams, and what is true of them now", () => {
    expect(peopleLines(info)).toEqual([
      "owner       Eric   owner   -  (on: Mac)",
      "p-aaaaaaaa  Avery  member  Rio  (2 invites waiting)",
      "p-bbbbbbbb  Guest  viewer  -  (off)",
    ]);
  });

  test("a line a team: who is on it and where it works", () => {
    expect(teamLines(info)).toEqual(["t-aaaaaaaa  Rio    Avery  /srv/rio", "t-bbbbbbbb  Empty  nobody"]);
  });

  test("activity names the person, the repo and a caller that was not a page", () => {
    const when = (at: number): string => `t${at}`;
    expect(
      activityLines(
        [
          { at: 2, person: "p-aaaaaaaa", kind: "cli", what: "pushed", repo: "rio" },
          { at: 1, person: "p-gonegone", kind: "page", what: "started a run" },
        ],
        info.people,
        when,
      ),
    ).toEqual(["t2  Avery  pushed in rio  (cli)", "t1  p-gonegone  started a run"]);
  });

  test("an invite is handed over as a link and as the CLI's line", () => {
    expect(inviteWords("https://canopy.example", "Avery", "cnv_abc", 5, (at) => `t${at}`)).toEqual([
      "invite for Avery, good once until t5:",
      "  in a browser   https://canopy.example/?join=cnv_abc",
      "  from a shell   canopy auth join cnv_abc --backend https://canopy.example",
    ]);
  });

  test("the roster reads back as a file the lookups take, the owner apart", () => {
    const file = rosterOf(info);
    expect(file.owner.name).toBe("Eric");
    expect(file.people.map((p) => p.id)).toEqual(["p-aaaaaaaa", "p-bbbbbbbb"]);
  });

  test("a flag given several times is every value, taken out of the words", () => {
    const words = ["Rio", "--folder", "/a", "--name", "x", "--folder", "/b"];
    expect(takeAll(words, "--folder")).toEqual(["/a", "/b"]);
    expect(words).toEqual(["Rio", "--name", "x"]);
  });

  test("auth status says whose the token is and what it holds, and reads an older backend's answer", () => {
    expect(statusWords({ mode: "enforce", refused: { count: 3 }, you: "cli", youId: "c1", person: { id: "p-a", name: "Avery", role: "member" }, rights: ["read", "plan", "operate"] })).toBe(
      "mode enforce  you cli  Avery (member)  holds read, plan, operate  refused 3",
    );
    expect(statusWords({ mode: "log", refused: { count: 0 }, you: "none", youId: null })).toBe("mode log  you none  refused 0");
  });
});

describe("canopy people against an enforce server", () => {
  let scratch = "";
  let port = 0;
  let stop: () => void | Promise<void> = () => {};
  const lines: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TOKEN", "CANOPY_API", "CANOPY_TMUX", "CANOPY_CALLERS", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS"];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "canopy-people-cli-"));
    for (const k of ENV) saved[k] = process.env[k];
    process.env["CANOPY_CONFIG_DIR"] = join(scratch, "server");
    process.env["CANOPY_CALLERS"] = "enforce";
    process.env["CANOPY_TMUX"] = "0";
    for (const k of ["CANOPY_TOKEN", "CANOPY_API", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS"]) delete process.env[k];
    await mkdir(join(scratch, "root"), { recursive: true });
    const s = await startServer({ root: join(scratch, "root"), port: 0, callersLog: (l) => lines.push(l) });
    port = s.port;
    stop = s.stop;
  });

  afterAll(async () => {
    await stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(scratch, { recursive: true, force: true });
  });

  const base = (): string => `http://127.0.0.1:${port}`;

  /** the CLI as one machine: `who` names its config dir, so each has its own token */
  const cli = async (who: string, ...args: string[]): Promise<{ code: number; out: string }> => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../../bin/canopy.ts"), ...args, "--backend", base()], {
      env: { ...process.env, CANOPY_CONFIG_DIR: join(scratch, who) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: o + e };
  };

  test("the owner adds a person, who joins with the invite and holds a member's rights", async () => {
    const code = /first sign-in code (\S+) /.exec(lines.findLast((l) => l.includes("first sign-in code")) ?? "")?.[1] ?? "";
    expect((await cli("eric", "auth", "login", "--code", code)).code).toBe(0);
    expect((await cli("eric", "people", "me", "--name", "Eric")).out).toContain("you are Eric (owner)");

    const team = await cli("eric", "people", "teams", "add", "Rio", "--folder", join(scratch, "root"));
    expect(team.code).toBe(0);
    expect(team.out).toContain("made Rio");

    const added = await cli("eric", "people", "add", "Avery", "--team", "rio");
    expect(added.code).toBe(0);
    expect(added.out).toContain("as member");
    const invite = /canopy auth join (cnv_[a-z2-7]{24})/.exec(added.out)?.[1] ?? "";
    expect(invite).not.toBe("");
    expect(added.out).toContain(`${base()}/?join=${invite}`);

    const joined = await cli("avery", "auth", "join", invite);
    expect(joined.code).toBe(0);
    expect(joined.out).toContain("as Avery");
    expect((await stat(join(scratch, "avery", `token-127.0.0.1-${port}`))).mode & 0o777).toBe(0o600);
    expect((await cli("avery", "auth", "join", invite)).code).toBe(1);

    const me = await cli("avery", "people", "me");
    expect(me.out).toContain("Avery");
    expect(me.out).toContain("member; this token holds read, plan, operate");
    expect((await cli("avery", "auth", "status")).out).toContain("Avery (member)");

    const refused = await cli("avery", "people", "add", "Friend");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("your role");

    const list = await cli("avery", "people");
    expect(list.out).toContain("Eric");
    expect(list.out).toMatch(/Avery\s+member\s+Rio/);
    expect((await cli("eric", "people", "teams")).out).toMatch(/Rio\s+Avery/);
  });

  test("a role change, an off and a remove each land, and the log names who did them", async () => {
    expect((await cli("eric", "people", "role", "avery", "viewer")).out).toContain("Avery: viewer");
    expect((await cli("avery", "people", "me")).out).toContain("viewer; this token holds read");
    expect((await cli("eric", "people", "role", "avery", "boss")).code).toBe(1);
    expect((await cli("eric", "people", "team", "avery", "none")).out.trim()).toBe("Avery: viewer");
    expect((await cli("eric", "people", "nobody-here")).code).toBe(1);
    expect((await cli("eric", "people", "role", "nobody", "viewer")).out).toContain("nobody here is called nobody");

    const off = await cli("eric", "people", "off", "Avery");
    expect(off.out).toContain("Avery is off");
    expect((await cli("avery", "people")).code).toBe(1);

    const log = await cli("eric", "people", "activity", "--limit", "20");
    expect(log.out).toContain("Eric  added a person  (cli)");
    expect(log.out).toContain("Eric  changed a person  (cli)");

    // a sign-out ends the member's own session without the admin right
    expect((await cli("eric", "people", "on", "avery")).code).toBe(0);
    const again = await cli("eric", "people", "invite", "avery", "--hours", "1");
    const invite = /canopy auth join (cnv_[a-z2-7]{24})/.exec(again.out)?.[1] ?? "";
    expect((await cli("avery", "auth", "join", invite)).code).toBe(0);
    expect((await cli("avery", "auth", "logout")).out).toContain("signed out");
    expect((await cli("eric", "people", "uninvite", "avery")).out).toContain("dropped 0 invites");
    expect((await cli("eric", "people", "remove", "avery")).out).toContain("removed Avery");
    expect((await cli("eric", "people")).out).not.toContain("Avery");
    expect((await cli("eric", "people", "teams", "remove", "rio")).out).toContain("removed Rio");
  });
});
