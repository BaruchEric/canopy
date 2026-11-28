/**
 * The other direction of the interop proof: open a callers.json the Rust
 * CallerBook wrote (canopy-auth's ignored test write_a_book_for_the_ts_to_read)
 * with the TS CallerBook, check every token the Rust minted, read the callers
 * back, and show that a TS write of the same state gives the Rust's bytes.
 *
 *   CANOPY_CONFIG_DIR=$PWD/cfg bun check-rust.ts <worktree>/src <dir>
 */
import { deepStrictEqual, strictEqual } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [src, dir] = process.argv.slice(2);
if (!src || !dir) throw new Error("usage: bun check-rust.ts <src> <dir>");
const { CallerBook } = await import(join(src, "server/callers.ts"));

const file = join(dir, "callers.json");
const rustBytes = readFileSync(file, "utf8");
const tokens = JSON.parse(readFileSync(join(dir, "tokens.json"), "utf8"));
let t: number = tokens.t0;
const book = new CallerBook({ file, now: () => t });

let checked = 0;
for (const m of tokens.minted) {
  deepStrictEqual(book.check(m.token), m.caller, m.token);
  strictEqual(book.check(`${m.token.slice(0, -1)}${m.token.endsWith("A") ? "B" : "A"}`), null);
  checked++;
}
const noLoop = (list: { id: string }[]) => list.filter((c) => c.id !== "loopback");
deepStrictEqual(noLoop(book.list()), noLoop(tokens.list));

// a TS write of the same state: mint one caller and revoke it again
const extra = book.mint("cli", { label: "extra" });
strictEqual(await book.revoke(extra.caller.id), true);
await book.flush();
strictEqual(readFileSync(file, "utf8"), rustBytes);

// and a revoke by the TS bites for the Rust's helper token
const helper = tokens.minted.find((m: { caller: { kind: string } }) => m.caller.kind === "helper");
strictEqual(await book.revoke(tokens.helperId), true);
strictEqual(book.check(helper.token), null);

console.log(`rust book: ${checked} tokens checked by the TS, list matches, TS rewrite is byte-identical`);
