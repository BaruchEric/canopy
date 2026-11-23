import { describe, expect, test } from "bun:test";
import {
  activityWords,
  addRefusal,
  allowsAs,
  cleanFolder,
  cleanName,
  colorOf,
  EMPTY_PEOPLE,
  everyone,
  findPerson,
  focusOf,
  handRefusal,
  inFocus,
  initials,
  inviteCode,
  inviteLife,
  isPersonId,
  mayGrant,
  meRefusal,
  mintInvite,
  mintPersonId,
  mintTeamId,
  OWNER_ID,
  ownerOf,
  parseActivity,
  parsePeople,
  parsePlaces,
  personOf,
  removeRefusal,
  rightsOf,
  setRefusal,
  teamRefusal,
  under,
  type PeopleFile,
  type Person,
} from "./people";

const person = (over: Partial<Person> & Pick<Person, "id" | "name" | "role">): Person => ({ teams: [], created: 1, ...over });

const file = (over: Partial<PeopleFile> = {}): PeopleFile => ({ ...EMPTY_PEOPLE, owner: { name: "Eric" }, ...over });

const avery = person({ id: "p-aaaaaaaa", name: "Avery", role: "member" });
const emma = person({ id: "p-bbbbbbbb", name: "Emma", role: "admin" });
const guest = person({ id: "p-cccccccc", name: "Guest", role: "viewer" });

describe("roles", () => {
  test("a caller holds what its kind and its role both hold", () => {
    expect(rightsOf("page", "owner")).toEqual(["read", "plan", "operate", "shell", "admin"]);
    expect(rightsOf("page", "member")).toEqual(["read", "plan", "operate", "shell"]);
    expect(rightsOf("page", "viewer")).toEqual(["read"]);
    expect(rightsOf("cli", "member")).toEqual(["read", "plan", "operate"]);
    // a member's shell token is the shell's, capped by the member
    expect(rightsOf("shell", "member")).toEqual(["read", "plan", "operate"]);
    expect(rightsOf("shell", "viewer")).toEqual(["read"]);
    expect(rightsOf("helper", "member")).toEqual(["helper"]);
    expect(rightsOf("helper", "viewer")).toEqual([]);
    expect(rightsOf("none", "owner")).toEqual([]);
  });

  test("open is everyone's, whatever the role", () => {
    expect(allowsAs("none", "viewer", "open")).toBe(true);
    expect(allowsAs("page", "viewer", "admin")).toBe(false);
  });

  test("nobody hands out more than they hold", () => {
    expect(mayGrant("owner", "owner")).toBe(true);
    expect(mayGrant("admin", "owner")).toBe(false);
    expect(mayGrant("admin", "admin")).toBe(true);
    expect(mayGrant("admin", "viewer")).toBe(true);
    expect(mayGrant("member", "viewer")).toBe(false);
    expect(mayGrant("viewer", "viewer")).toBe(false);
  });
});

describe("ids, names and invites", () => {
  test("ids are minted in their shape", () => {
    const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(33);
    expect(mintPersonId(bytes)).toBe("p-bbbbbbbb");
    expect(mintTeamId(bytes)).toBe("t-bbbbbbbb");
    expect(mintInvite(bytes)).toBe(`cnv_${"b".repeat(24)}`);
    expect(isPersonId(mintPersonId())).toBe(true);
    expect(isPersonId(OWNER_ID)).toBe(true);
    expect(isPersonId("p-UPPER123")).toBe(false);
  });

  test("an invite is read as typed", () => {
    const code = mintInvite();
    expect(inviteCode(`  ${code.toUpperCase()} `)).toBe(code);
    expect(inviteCode("cnv_short")).toBeNull();
    expect(inviteCode("")).toBeNull();
  });

  test("an invite lasts 72 hours unless it says otherwise, within an hour and 30 days", () => {
    expect(inviteLife(undefined)).toBe(72 * 3600_000);
    expect(inviteLife(1)).toBe(3600_000);
    expect(inviteLife(0.5)).toBeNull();
    expect(inviteLife(721)).toBeNull();
    expect(inviteLife("3")).toBeNull();
  });

  test("a name is one line, cut at 40", () => {
    expect(cleanName("  Avery\n Baruch  ")).toBe("Avery Baruch");
    expect(cleanName("x".repeat(60))).toHaveLength(40);
    expect(cleanName("\u0000\t")).toBe("");
  });

  test("initials and a colour", () => {
    expect(initials("Avery Baruch")).toBe("AB");
    expect(initials("emma")).toBe("EM");
    expect(initials("  ")).toBe("?");
    expect(colorOf({ id: "p-aaaaaaaa", color: 200 })).toBe(200);
    expect(colorOf({ id: "p-aaaaaaaa" }) % 30).toBe(0);
  });
});

describe("the file", () => {
  test("nothing is the owner alone", () => {
    const f = parsePeople(null);
    expect(everyone(f)).toEqual([{ id: "owner", name: "owner", role: "owner", teams: [], created: 0 }]);
  });

  test("a bad record is dropped, never the file", () => {
    const f = parsePeople({
      owner: { name: " Eric ", color: 120 },
      teams: [{ id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio/", "relative", 3], created: 5 }, { id: "nope", name: "x" }, { id: "t-bbbbbbbb", name: "rio" }],
      people: [
        { id: "p-aaaaaaaa", name: "Avery", role: "member", teams: ["t-aaaaaaaa", "t-zzzzzzzz"], created: 9, off: true },
        { id: "p-bbbbbbbb", name: "avery", role: "viewer" },
        { id: "p-cccccccc", name: "Eric", role: "viewer" },
        { id: "p-dddddddd", name: "Dana", role: "boss" },
        { id: "owner", name: "Sneaky", role: "owner" },
        "junk",
      ],
      invites: [
        { hash: "a".repeat(64), person: "p-aaaaaaaa", created: 1, expires: 2, by: "owner" },
        { hash: "short", person: "p-aaaaaaaa", created: 1, expires: 2 },
        { hash: "b".repeat(64), person: "p-gone1234", created: 1, expires: 2 },
      ],
    });
    expect(f.owner).toEqual({ name: "Eric", color: 120 });
    expect(f.teams).toEqual([{ id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio"], created: 5 }]);
    expect(f.people).toEqual([{ id: "p-aaaaaaaa", name: "Avery", role: "member", teams: ["t-aaaaaaaa"], created: 9, off: true }]);
    expect(f.invites).toHaveLength(1);
  });

  test("a session with no person is the owner's, and one whose person is gone or off is nobody's", () => {
    const f = file({ people: [avery, { ...guest, off: true }] });
    expect(personOf(f, undefined)).toEqual(ownerOf(f));
    expect(personOf(f, avery.id)?.name).toBe("Avery");
    expect(personOf(f, guest.id)).toBeNull();
    expect(personOf(f, "p-gone1234")).toBeNull();
  });

  test("a person is found by id or by name, without case", () => {
    const f = file({ people: [avery] });
    expect(findPerson(f, "avery")?.id).toBe(avery.id);
    expect(findPerson(f, avery.id)?.name).toBe("Avery");
    expect(findPerson(f, "ERIC")?.id).toBe(OWNER_ID);
    expect(findPerson(f, "nobody")).toBeUndefined();
  });
});

describe("the rules", () => {
  const f = file({ people: [avery, emma, guest], teams: [{ id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio"], created: 1 }] });
  const owner = ownerOf(f);

  test("adding", () => {
    expect(addRefusal(f, owner, { name: "Dana", role: "owner", teams: [] })).toBeNull();
    expect(addRefusal(f, emma, { name: "Dana", role: "admin", teams: ["t-aaaaaaaa"] })).toBeNull();
    expect(addRefusal(f, emma, { name: "Dana", role: "owner", teams: [] })).toBe("only an owner makes an owner");
    expect(addRefusal(f, avery, { name: "Dana", role: "viewer", teams: [] })).toBe("adding a person takes the admin right");
    expect(addRefusal(f, owner, { name: "avery", role: "viewer", teams: [] })).toBe("avery is someone here already");
    expect(addRefusal(f, owner, { name: "eric", role: "viewer", teams: [] })).toBe("eric is someone here already");
    expect(addRefusal(f, owner, { name: "", role: "viewer", teams: [] })).toBe("a person needs a name");
    expect(addRefusal(f, owner, { name: "Dana", role: "viewer", teams: ["t-zzzzzzzz"] })).toBe("no team t-zzzzzzzz");
  });

  test("changing", () => {
    expect(setRefusal(f, owner, avery, { role: "admin" })).toBeNull();
    expect(setRefusal(f, emma, avery, { role: "owner" })).toBe("only an owner makes an owner");
    expect(setRefusal(f, emma, owner, { name: "Boss" })).toBe("only an owner changes Eric");
    expect(setRefusal(f, owner, owner, { role: "viewer" })).toBe("the owner stays the owner");
    expect(setRefusal(f, owner, owner, { off: true })).toBe("the owner cannot be turned off");
    expect(setRefusal(f, owner, owner, { name: "Eric B" })).toBeNull();
    expect(setRefusal(f, emma, emma, { role: "viewer" })).toBe("someone else changes your role");
    expect(setRefusal(f, emma, emma, { off: true })).toBe("sign out instead; someone else turns you off");
    expect(setRefusal(f, owner, avery, { name: "Emma" })).toBe("Emma is someone here already");
    expect(setRefusal(f, owner, avery, { name: "AVERY" })).toBeNull();
    expect(setRefusal(f, owner, avery, { color: 400 })).toBe("a colour is a hue from 0 to 359");
    expect(setRefusal(f, owner, avery, { color: null })).toBeNull();
    expect(setRefusal(f, avery, guest, { name: "G" })).toBe("changing a person takes the admin right");
  });

  test("removing", () => {
    expect(removeRefusal(owner, avery)).toBeNull();
    expect(removeRefusal(emma, owner)).toBe("the owner cannot be removed");
    expect(removeRefusal(emma, emma)).toBe("sign out instead; someone else removes you");
    expect(removeRefusal(emma, person({ id: "p-dddddddd", name: "Co", role: "owner" }))).toBe("only an owner removes Co");
    expect(removeRefusal(avery, guest)).toBe("removing a person takes the admin right");
  });

  test("handing a sign-in out", () => {
    expect(handRefusal(owner, owner)).toBeNull();
    expect(handRefusal(emma, emma)).toBeNull();
    expect(handRefusal(emma, avery)).toBeNull();
    expect(handRefusal(emma, owner)).toBe("only an owner signs Eric in");
    expect(handRefusal(avery, avery)).toBe("handing out a sign-in takes the admin right");
    expect(handRefusal(owner, { ...guest, off: true })).toBe("Guest is turned off");
  });

  test("a team needs a name of its own and absolute folders", () => {
    expect(teamRefusal(f, { name: "Family", folders: ["/home/x", "ssh://mini/srv"] })).toBeNull();
    expect(teamRefusal(f, { name: "rio", folders: [] })).toBe("there is a team rio already");
    expect(teamRefusal(f, { name: "rio", folders: [] }, "t-aaaaaaaa")).toBeNull();
    expect(teamRefusal(f, { name: "", folders: [] })).toBe("a team needs a name");
    expect(teamRefusal(f, { name: "X", folders: ["dev/x"] })).toBe("dev/x is not an absolute path on this backend");
  });
});

describe("a team's scope", () => {
  const teams = [
    { id: "t-aaaaaaaa", name: "Rio", folders: ["/srv/rio", "/srv/clms"], created: 1 },
    { id: "t-bbbbbbbb", name: "Empty", folders: [], created: 1 },
  ];
  const f = file({ teams });

  test("a folder is kept without its trailing slash", () => {
    expect(cleanFolder("/srv/rio//")).toBe("/srv/rio");
    expect(cleanFolder("/")).toBe("/");
    expect(cleanFolder("ssh://mini/srv/x/")).toBe("ssh://mini/srv/x");
    expect(cleanFolder("srv")).toBeNull();
  });

  test("under is the folder or below it, never a sibling with its prefix", () => {
    expect(under("/srv/rio", "/srv/rio")).toBe(true);
    expect(under("/srv/rio/app", "/srv/rio")).toBe(true);
    expect(under("/srv/rio-old", "/srv/rio")).toBe(false);
    expect(under("/anything", "/")).toBe(true);
  });

  test("a person on no team has no focus, and no focus holds every repo", () => {
    expect(focusOf(f.teams, ownerOf(f))).toEqual([]);
    expect(focusOf(f.teams, avery)).toEqual([]);
    expect(inFocus([], "/anywhere")).toBe(true);
  });

  test("a person's focus is their teams' folders, whatever their role", () => {
    const focus = focusOf(f.teams, { ...avery, teams: ["t-aaaaaaaa"] });
    expect(focus).toEqual(["/srv/rio", "/srv/clms"]);
    expect(inFocus(focus, "/srv/clms/web")).toBe(true);
    expect(inFocus(focus, "/srv/other")).toBe(false);
    expect(focusOf(f.teams, { ...emma, teams: ["t-aaaaaaaa"] })).toEqual(focus);
  });

  test("a team that names no folder narrows nothing", () => {
    const focus = focusOf(f.teams, { ...guest, teams: ["t-bbbbbbbb"] });
    expect(focus).toEqual([]);
    expect(inFocus(focus, "/srv/rio")).toBe(true);
  });

  test("a person renames and recolours themselves, never into another's name", () => {
    const roster = file({ people: [avery, emma] });
    expect(meRefusal(roster, avery, { name: "Ari" })).toBeNull();
    expect(meRefusal(roster, avery, { name: "emma" })).not.toBeNull();
    expect(meRefusal(roster, avery, { name: "" })).not.toBeNull();
    expect(meRefusal(roster, avery, { color: 200 })).toBeNull();
    expect(meRefusal(roster, avery, { color: 400 })).not.toBeNull();
    expect(meRefusal(roster, avery, { color: null })).toBeNull();
  });
});

describe("activity and places", () => {
  test("only the writes with words are logged", () => {
    expect(activityWords("POST", "/api/repos/push")).toBe("pushed");
    expect(activityWords("GET", "/api/repos/push")).toBeNull();
    expect(activityWords("POST", "/api/presence/beat")).toBeNull();
  });

  test("a line is read back or dropped", () => {
    expect(parseActivity({ at: 5, person: "owner", kind: "page", what: "pushed", repo: "clms" })).toEqual({ at: 5, person: "owner", kind: "page", what: "pushed", repo: "clms" });
    expect(parseActivity({ at: 5, person: "owner", kind: "robot", what: "pushed" })).toBeNull();
    expect(parseActivity("x")).toBeNull();
  });

  test("a place is at most twelve repo ids, each once", () => {
    expect(parsePlaces(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parsePlaces(Array.from({ length: 20 }, (_, i) => `r${i}`))).toHaveLength(12);
    expect(parsePlaces(["a", 3])).toBeNull();
    expect(parsePlaces("a")).toBeNull();
  });
});
