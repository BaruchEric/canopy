import { describe, expect, test } from "bun:test";
import { AGE_HEAD } from "./secretfile";
import { ACT_KINDS, LIMITS, encodeLine, parseAct, parseProposals, parseReply, parseRequest, skippedWords, type ActKind } from "./secretwire";
import { SAMPLES } from "./secretwire.samples";

describe("parseAct", () => {
  test("the samples cover every act kind", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ACT_KINDS].sort());
  });

  test.each(ACT_KINDS.map((k) => [k]))("%s: the good sample parses and the bad one is refused", (k) => {
    const s = SAMPLES[k as ActKind];
    expect(parseAct(s.good)).toEqual(s.good);
    expect("error" in (parseAct(s.bad) as object)).toBe(true);
  });

  test("sink-set carries a restart project or none, and refuses anything else there", () => {
    const base = { a: "sink-set", id: "dns", machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } } as const;
    expect(parseAct({ ...base, restart: "dns-prod" })).toEqual({ ...base, restart: "dns-prod" });
    expect(parseAct({ ...base, restart: "none" })).toEqual({ ...base, restart: "none" });
    expect(parseAct(base)).toEqual(base);
    expect(parseAct({ ...base, restart: "Dns Prod" })).toEqual({ error: "sink-set: restart, a compose project name or none" });
  });

  test("an unknown kind is refused", () => {
    expect(parseAct({ a: "get-all" })).toEqual({ error: "unknown act get-all" });
  });
});

describe("parseRequest and parseReply", () => {
  test("a request round-trips through a line", () => {
    const req = { t: "act" as const, token: "tok", act: SAMPLES.reveal.good };
    expect(parseRequest(encodeLine(req).trimEnd())).toEqual(req);
  });

  test("refuses an unknown request, a bad act, and a line over the limit", () => {
    expect("error" in parseRequest('{"t":"dump"}')).toBe(true);
    expect("error" in parseRequest('{"t":"act","token":"x","act":{"a":"delete"}}')).toBe(true);
    expect("error" in parseRequest("x".repeat(LIMITS.line + 1))).toBe(true);
  });

  test("a reply carries the passkey gate through", () => {
    expect(parseReply('{"ok":false,"error":"open the gate","gate":"passkey"}')).toEqual({ ok: false, error: "open the gate", gate: "passkey" });
    expect(parseReply("nope")).toBeNull();
  });
});

describe("skippedWords", () => {
  test("names a file's unread lines by number, one or many, and stops listing after twelve", () => {
    expect(skippedWords({ path: "/d/.env", lines: [8] })).toBe("/d/.env: line 8 is not KEY=value, so it was left out; a sink of this file leaves it as it is");
    expect(skippedWords({ path: "/d/.env", lines: [8, 11] })).toBe("/d/.env: lines 8, 11 are not KEY=value, so they were left out; a sink of this file leaves them as they are");
    const long = skippedWords({ path: "/d/.env", lines: Array.from({ length: 15 }, (_, i) => i + 1) });
    expect(long).toContain("lines 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 and 3 more are not KEY=value");
  });
});

describe("parseProposals", () => {
  const one = { from: "mac", source: "/Users/e/dev/.env", key: "CF_TOKEN", sealed: `${AGE_HEAD}\nx\n`, merges: null };

  test("takes a batch within the limits", () => {
    expect(parseProposals([one])).toEqual([one]);
  });

  test("keeps the partial mark of a file with unread lines, and nothing else a caller adds", () => {
    expect(parseProposals([{ ...one, partial: true, extra: "x" }])).toEqual([{ ...one, partial: true }]);
    expect(parseProposals([{ ...one, partial: false }])).toEqual([one]);
    expect("error" in (parseProposals([{ ...one, partial: "yes" }]) as object)).toBe(true);
  });

  test("refuses too many, too large, or a sealed field that is not age", () => {
    expect("error" in (parseProposals(Array.from({ length: LIMITS.proposals + 1 }, () => one)) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, sealed: AGE_HEAD + "x".repeat(LIMITS.sealed) }]) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, sealed: "plain value" }]) as object)).toBe(true);
    expect("error" in (parseProposals([{ ...one, from: "Mac Book" }]) as object)).toBe(true);
  });
});
