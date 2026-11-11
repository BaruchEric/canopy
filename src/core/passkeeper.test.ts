import { describe, expect, test } from "bun:test";
import { keeperAccount, KEYCHAIN_SERVICE, keychainKeeper, localKeeper, type KeeperRun } from "./passkeeper";

const NONE = "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";

/** /usr/bin/security as far as the keeper uses it: one item for a service and an account */
function fakeSecurity(o: { deaf?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: { argv: string[]; input: string | undefined }[] = [];
  let down = false;
  const after = (words: readonly string[], flag: string): string => words[words.indexOf(flag) + 1] ?? "";
  const run: KeeperRun = async (argv, input) => {
    calls.push({ argv, input });
    if (down) return { code: 1, stdout: "", stderr: "security: the keychain did not answer\n" };
    if (argv[1] === "-i") {
      const words = (input ?? "").trim().split(/\s+/);
      if (words[0] !== "add-generic-password" || !words.includes("-U")) return { code: 2, stdout: "", stderr: "usage" };
      if (!o.deaf) items.set(`${after(words, "-s")}/${after(words, "-a")}`, after(words, "-w"));
      return { code: 0, stdout: "", stderr: "" };
    }
    const key = `${after(argv, "-s")}/${after(argv, "-a")}`;
    if (argv[1] === "find-generic-password") {
      const v = items.get(key);
      return v === undefined ? { code: 44, stdout: "", stderr: NONE } : { code: 0, stdout: `${v}\n`, stderr: "" };
    }
    if (argv[1] === "delete-generic-password") return items.delete(key) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: NONE };
    return { code: 2, stdout: "", stderr: "usage" };
  };
  return {
    run,
    items,
    calls,
    fail: () => {
      down = true;
    },
  };
}

describe("a passphrase kept in the keychain", () => {
  test("it is kept, read back and taken out, and taking out nothing is no failure", async () => {
    const s = fakeSecurity();
    const k = keychainKeeper("mac", s.run);
    expect(await k.read()).toBeNull();
    await k.write("correct horse battery");
    expect([...s.items.keys()]).toEqual([`${KEYCHAIN_SERVICE}/mac`]);
    expect(await k.read()).toBe("correct horse battery");
    await k.write("another one entirely");
    expect(await k.read()).toBe("another one entirely");
    await k.drop();
    expect(await k.read()).toBeNull();
    await k.drop();
  });

  test("each machine has its own item", async () => {
    const s = fakeSecurity();
    await keychainKeeper("mac", s.run).write("the mac's passphrase");
    expect(await keychainKeeper("gpd", s.run).read()).toBeNull();
  });

  test("the passphrase never rides a command line, and what is stored is plain ascii whatever was typed", async () => {
    const s = fakeSecurity();
    const k = keychainKeeper("mac", s.run);
    const pass = " With Spaces & 'quotes' \"too\" \\ pässwörd-日本語 ";
    await k.write(pass);
    expect(await k.read()).toBe(pass);
    expect(s.items.get(`${KEYCHAIN_SERVICE}/mac`)).toMatch(/^canopy1:[A-Za-z0-9_-]+$/);
    for (const c of s.calls) {
      expect(c.argv.join(" ")).not.toContain("pässwörd");
      expect(c.argv.join(" ")).not.toContain("canopy1:");
      expect(c.input ?? "").not.toContain("pässwörd");
    }
  });

  test("an item canopy did not write reads as none", async () => {
    const s = fakeSecurity();
    s.items.set(`${KEYCHAIN_SERVICE}/mac`, "typed into Keychain Access by hand");
    expect(await keychainKeeper("mac", s.run).read()).toBeNull();
    s.items.set(`${KEYCHAIN_SERVICE}/mac`, "canopy1:not*base64");
    expect(await keychainKeeper("mac", s.run).read()).toBeNull();
  });

  test("a keychain that does not answer fails with its reason and never with the passphrase", async () => {
    const s = fakeSecurity();
    const k = keychainKeeper("mac", s.run);
    s.fail();
    await expect(k.read()).rejects.toThrow("the keychain did not answer");
    const err = await k.write("correct horse battery").then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : ""),
    );
    expect(err).toContain("the keychain did not answer");
    expect(err).not.toContain("correct horse");
    expect(err).not.toContain("canopy1:");
    await expect(k.drop()).rejects.toThrow("the keychain did not answer");
  });

  test("a write that does not read back is a failure", async () => {
    const s = fakeSecurity({ deaf: true });
    await expect(keychainKeeper("mac", s.run).write("correct horse battery")).rejects.toThrow("did not read back");
  });

  test("the account is a plain word and nothing else", () => {
    expect(() => keychainKeeper("mac; rm -rf", fakeSecurity().run)).toThrow("cannot name a keychain item");
    expect(() => keychainKeeper("", fakeSecurity().run)).toThrow("cannot name a keychain item");
  });

  test("an item belongs to one key file: a second canopy on the machine, with its own config folder, has another", () => {
    const real = keeperAccount("mac", "/Users/e/.config/canopy/secrets-key.age");
    const scratch = keeperAccount("mac", "/tmp/scratch/config/secrets-key.age");
    expect(real).toMatch(/^mac\.[0-9a-f]{8}$/);
    expect(scratch).not.toBe(real);
    expect(keeperAccount("mac", "/Users/e/.config/canopy/secrets-key.age")).toBe(real);
  });

  test("only a Mac has a keychain to keep one in, and only for a machine with a plain name", () => {
    expect(localKeeper("mac", "/Users/e/.config/canopy/secrets-key.age", "darwin")).not.toBeNull();
    expect(localKeeper("mac", "/home/e/.config/canopy/secrets-key.age", "linux")).toBeNull();
    expect(localKeeper("my mac", "/Users/e/.config/canopy/secrets-key.age", "darwin")).toBeNull();
  });
});
