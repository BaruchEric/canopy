import { describe, expect, test } from "bun:test";
import type { PersonHere } from "../../src/core/people";
import { holds, managesPeople, readsAdmin } from "./callerToken";
import { expiresWords, faceOf, focusFor, grantable, inviteLink, isRoster, joinCodeIn, nameOf, othersAt, othersHere, roleLimit, startsFocused, withoutJoin, type Roster } from "./people";

const here = (over: Partial<PersonHere> & Pick<PersonHere, "id" | "name" | "role">): PersonHere => ({ teams: [], created: 1, devices: [], at: [], invited: 0, ...over });
const mac = { id: "a", name: "Mac", platform: "mac" };

const roster: Roster = {
  people: [
    here({ id: "owner", name: "Eric Baruch", role: "owner", devices: [mac], at: ["rio"] }),
    here({ id: "p-aaaaaaaa", name: "Avery", role: "member", teams: ["t-aaaaaaaa"], devices: [mac], at: ["rio", "clms"] }),
    here({ id: "p-bbbbbbbb", name: "Guest", role: "viewer", color: 200 }),
    here({ id: "p-cccccccc", name: "Off", role: "member", off: true, devices: [mac] }),
  ],
  teams: [{ id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio"], created: 1 }],
  invites: [],
};

describe("faces", () => {
  test("a face is two letters on the person's hue, their own colour when they picked one", () => {
    expect(faceOf(roster.people[0] ?? here({ id: "x", name: "x", role: "viewer" })).letters).toBe("EB");
    expect(faceOf({ id: "p-bbbbbbbb", name: "Guest", color: 200 })).toEqual({ id: "p-bbbbbbbb", name: "Guest", letters: "GU", hue: 200 });
    expect(nameOf(roster.people, "p-aaaaaaaa")).toBe("Avery");
    expect(nameOf(roster.people, "p-gonegone")).toBe("p-gonegone");
    expect(nameOf(undefined, "owner")).toBe("owner");
  });
});

describe("who is here", () => {
  test("the others with a browser on, never me, never someone turned off", () => {
    expect(othersHere(roster, "owner").map((p) => p.name)).toEqual(["Avery"]);
    expect(othersHere(roster, "p-aaaaaaaa").map((p) => p.name)).toEqual(["Eric Baruch"]);
    expect(othersHere(undefined, "owner")).toEqual([]);
  });

  test("the others who have a repo open", () => {
    expect(othersAt(roster, "owner", "clms").map((p) => p.name)).toEqual(["Avery"]);
    expect(othersAt(roster, "owner", "rio").map((p) => p.name)).toEqual(["Avery"]);
    expect(othersAt(roster, "p-aaaaaaaa", "clms")).toEqual([]);
  });

  test("a person's focus is their teams' folders, and nobody's without a team", () => {
    expect(focusFor(roster, "p-aaaaaaaa")).toEqual(["/srv/rio"]);
    expect(focusFor(roster, "owner")).toEqual([]);
    expect(focusFor(roster, "p-gonegone")).toEqual([]);
    expect(focusFor(undefined, "owner")).toEqual([]);
  });
});

describe("where a page starts", () => {
  test("a member or a viewer with team folders starts on them; an owner, an admin and a person with none start on everything", () => {
    expect(startsFocused("member", ["/srv/rio"])).toBe(true);
    expect(startsFocused("viewer", ["/srv/rio"])).toBe(true);
    expect(startsFocused("member", [])).toBe(false);
    expect(startsFocused("member", undefined)).toBe(false);
    expect(startsFocused("owner", ["/srv/rio"])).toBe(false);
    expect(startsFocused("admin", ["/srv/rio"])).toBe(false);
    expect(startsFocused(undefined, ["/srv/rio"])).toBe(false);
  });
});

describe("invites", () => {
  test("a link's invite is read off its query, and anything else is not one", () => {
    expect(joinCodeIn("?join=cnv_abcdefghijklmnopqrstuvwx")).toBe("cnv_abcdefghijklmnopqrstuvwx");
    expect(joinCodeIn("?view=people&join=CNV_ABCDEFGHIJKLMNOPQRSTUVWX")).toBe("cnv_abcdefghijklmnopqrstuvwx");
    expect(joinCodeIn("?join=nope")).toBeNull();
    expect(joinCodeIn("?view=people")).toBeNull();
  });

  test("the invite leaves the URL and the rest of it stays", () => {
    expect(withoutJoin("https://canopy.example/?view=people&join=cnv_x#top")).toBe("/?view=people#top");
    expect(withoutJoin("https://canopy.example/?join=cnv_x")).toBe("/");
    expect(inviteLink("https://canopy.example", "cnv_x")).toBe("https://canopy.example/?join=cnv_x");
  });

  test("how long an invite has left", () => {
    const hour = 3_600_000;
    expect(expiresWords(72 * hour, 0)).toBe("3 days left");
    expect(expiresWords(5 * hour + 1, 0)).toBe("5 h left");
    expect(expiresWords(20 * 60_000, 0)).toBe("20 min left");
    expect(expiresWords(10, 0)).toBe("1 min left");
    expect(expiresWords(0, 0)).toBe("expired");
  });
});

describe("roles on the page", () => {
  test("a viewer is told they start nothing; a member and an owner are told nothing", () => {
    expect(roleLimit("viewer", ["read"])).toContain("viewing");
    expect(roleLimit("member", ["read", "plan", "operate", "shell"])).toBeNull();
    expect(roleLimit(undefined, undefined)).toBeNull();
  });

  test("nobody hands out more than they hold", () => {
    expect(grantable("owner")).toEqual(["owner", "admin", "member", "viewer"]);
    expect(grantable("admin")).toEqual(["admin", "member", "viewer"]);
    expect(grantable("member")).toEqual([]);
    expect(grantable(undefined)).toEqual([]);
  });

  test("the page reads its rights off what the backend listed, which a role caps", () => {
    expect(holds({ you: "page", rights: ["read"] }, "operate")).toBe(false);
    expect(holds({ you: "page" }, "admin")).toBe(true);
    expect(readsAdmin({ mode: "enforce", you: "page", rights: ["read", "plan", "operate", "shell"] })).toBe(false);
    expect(readsAdmin({ mode: "log", you: "page", rights: ["read"] })).toBe(true);
  });

  test("managing people takes a signed-in admin, even where the backend only logs", () => {
    const owner = { id: "owner", name: "Eric", role: "owner" as const };
    expect(managesPeople({ you: "page", rights: ["read", "plan", "operate", "shell", "admin"], person: owner })).toBe(true);
    expect(managesPeople({ you: "none", rights: [], person: owner })).toBe(false);
    expect(managesPeople({ you: "page", rights: ["read"], person: { id: "p-a", name: "A", role: "viewer" } })).toBe(false);
    expect(managesPeople({ you: "page", rights: ["admin"], person: null })).toBe(false);
    expect(managesPeople(undefined)).toBe(false);
  });
});

describe("a roster's shape", () => {
  test("an older backend's answer is not one", () => {
    expect(isRoster(roster)).toBe(true);
    expect(isRoster({ error: "not found" })).toBe(false);
    expect(isRoster(null)).toBe(false);
  });
});
