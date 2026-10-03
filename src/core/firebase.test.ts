import { describe, expect, test } from "bun:test";
import { firebaseConfigRefusal, firebaseEnv, firebaseFiles, firebaseProjectId, firebaseResult, isPlainRelative, sdkConfigOf } from "./firebase";

describe("firebaseConfigRefusal", () => {
  const ok = { $schema: "./node_modules/firebase-tools/schema/firebase-config.json", firestore: { rules: "firestore.rules", indexes: "firestore.indexes.json" }, emulators: { firestore: { port: 8080 } } };
  const why = (v: unknown): string | null => firebaseConfigRefusal(JSON.stringify(v));

  test("Firestore's rules and indexes, the emulators and the schema pass", () => {
    expect(why(ok)).toBe(null);
    expect(why({ firestore: { rules: "db/firestore.rules" } })).toBe(null);
    expect(firebaseFiles(JSON.stringify(ok))).toEqual(["firestore.rules", "firestore.indexes.json"]);
  });

  test("no file, not JSON, or no rules is refused", () => {
    expect(firebaseConfigRefusal(null)).toBe("a vercel+firebase project needs a firebase.json naming its Firestore rules");
    expect(firebaseConfigRefusal("{nope")).toBe("firebase.json is not JSON");
    expect(why([])).toBe("firebase.json must be an object");
    expect(why({ emulators: {} })).toBe("firebase.json needs firestore, an object naming its rules file");
    expect(why({ firestore: [{ database: "(default)", rules: "r" }] })).toBe("firebase.json needs firestore, an object naming its rules file");
    expect(why({ firestore: { indexes: "i.json" } })).toBe("firestore.rules must name a rules file inside the repo by a plain relative path");
  });

  test("a hook anywhere, any other product, or another Firestore key is refused", () => {
    expect(why({ ...ok, firestore: { ...ok.firestore, predeploy: ["curl evil"] } })).toBe("firebase.json holds firestore.predeploy; canopy runs no deploy hook");
    expect(why({ ...ok, emulators: { x: [{ postdeploy: "x" }] } })).toBe("firebase.json holds emulators.x[0].postdeploy; canopy runs no deploy hook");
    expect(why({ ...ok, hosting: { postDeploy: "x" } })).toBe("firebase.json holds hosting.postDeploy; canopy runs no deploy hook");
    for (const k of ["hosting", "functions", "storage", "database", "extensions", "dataconnect", "apphosting", "remoteconfig", "anything"]) {
      expect(why({ ...ok, [k]: {} })).toBe(`firebase.json holds ${k}; canopy deploys Firestore rules and indexes only`);
    }
    expect(why({ firestore: { rules: "r", database: "other" } })).toBe("firebase.json holds firestore.database; canopy takes firestore.rules and firestore.indexes only");
  });

  test("a rules or indexes path that leaves the repo is refused", () => {
    for (const p of ["/etc/passwd", "../x.rules", "a/../../x", "~/.config/x", "a\\b", "./", "a//b", ""]) {
      expect(isPlainRelative(p)).toBe(false);
      expect(why({ firestore: { rules: p } })).toContain("plain relative path");
    }
    expect(why({ firestore: { rules: "r", indexes: "../i.json" } })).toBe("firestore.indexes must name an indexes file inside the repo by a plain relative path");
    expect(isPlainRelative("rules/firestore.rules")).toBe(true);
  });
});

describe("firebaseProjectId", () => {
  test("lowercase, a letter first, at most 30, the hex suffix kept", () => {
    expect(firebaseProjectId("coin-counter", "a1b2c3")).toBe("coin-counter-a1b2c3");
    const long = firebaseProjectId("a-very-long-slug-for-a-laundromat-coin-counter", "a1b2c3");
    expect(long.length).toBeLessThanOrEqual(30);
    expect(long).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    expect(firebaseProjectId("3d-google-maps", "a1b2c3")).toBe("d-app-maps-a1b2c3");
    expect(firebaseProjectId("---", "a1b2c3")).toBe("sprout-a1b2c3");
    expect(() => firebaseProjectId("x", "zz")).toThrow("six hex digits");
  });
});

describe("the web app config and the CLI's answers", () => {
  test("each config key goes to Vercel under the Vite and Next prefixes; nothing else", () => {
    const env = firebaseEnv({ apiKey: "AIza", projectId: "coin-a1b2c3", appId: "1:2:web:3", databaseURL: "https://x", locationId: "nam5", authDomain: 4 });
    expect(env).toEqual({
      VITE_FIREBASE_API_KEY: "AIza",
      NEXT_PUBLIC_FIREBASE_API_KEY: "AIza",
      VITE_FIREBASE_PROJECT_ID: "coin-a1b2c3",
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: "coin-a1b2c3",
      VITE_FIREBASE_APP_ID: "1:2:web:3",
      NEXT_PUBLIC_FIREBASE_APP_ID: "1:2:web:3",
    });
  });

  test("--json answers: the result on success, one line of error otherwise", () => {
    expect(firebaseResult(JSON.stringify({ status: "success", result: { projectId: "p" } }))).toEqual({ ok: true, result: { projectId: "p" } });
    expect(firebaseResult(JSON.stringify({ status: "error", error: "Failed to create project.\nQuota exceeded" }))).toEqual({ ok: false, error: "Failed to create project. Quota exceeded" });
    expect(firebaseResult("Error: no")).toEqual({ ok: false, error: "the firebase CLI did not answer JSON" });
    expect(sdkConfigOf({ fileName: "x", sdkConfig: { projectId: "p" } })).toEqual({ projectId: "p" });
    expect(sdkConfigOf({ projectId: "p", appId: "a" })).toEqual({ projectId: "p", appId: "a" });
    expect(sdkConfigOf("x")).toBe(null);
  });
});
