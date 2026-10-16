import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { askSecrets, SECRETS_AWAY } from "../core/secretsclient";
import { LIMITS, type SecretsReply, type SecretsRequest } from "../core/secretwire";
import { DEFAULT_BREAKGLASS, serve, serviceEnv, socketModes } from "./main";

describe("serviceEnv", () => {
  test("defaults around the one required variable", () => {
    const e = serviceEnv({ CANOPY_SECRETS_CALLER_GID: "7851" });
    if ("refused" in e) throw new Error(e.refused);
    expect(e).toMatchObject({
      socket: "/run/canopy-secrets/secrets.sock",
      callerGid: 7851,
      data: "/data",
      remote: null,
      origin: "https://canopy.beric.ca",
      rpID: "canopy.beric.ca",
      gateUrl: "https://canopy.beric.ca/?view=secrets",
      breakglass: DEFAULT_BREAKGLASS,
      sinkRoots: ["/opt/stacks"],
      extra: ["/import/canopy.env"],
      restartDir: "/restart",
      restartHost: "192.168.48.1",
      restartUser: "eric",
    });
  });

  test.each([
    [{}, "CANOPY_SECRETS_CALLER_GID"],
    [{ CANOPY_SECRETS_CALLER_GID: "0" }, "CANOPY_SECRETS_CALLER_GID"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_ORIGIN: "http://canopy.beric.ca" }, "https"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_BREAKGLASS: "age1short" }, "BREAKGLASS"],
    [{ CANOPY_SECRETS_CALLER_GID: "7851", CANOPY_SECRETS_SINK_ROOTS: "relative" }, "SINK_ROOTS"],
  ])("refuses %p", (env, words) => {
    const e = serviceEnv(env as Record<string, string>);
    expect("refused" in e ? e.refused : "").toContain(words);
  });
});

test("socketModes: the folder root:gid 0750, the socket root:gid 0660", async () => {
  const calls: string[] = [];
  const fs = { chown: async (p: string, u: number, g: number) => void calls.push(`chown ${p} ${u}:${g}`), chmod: async (p: string, m: number) => void calls.push(`chmod ${p} ${m.toString(8)}`) };
  await socketModes("/run/s", "/run/s/x.sock", 7851, fs);
  expect(calls).toEqual(["chown /run/s 0:7851", "chmod /run/s 750", "chown /run/s/x.sock 0:7851", "chmod /run/s/x.sock 660"]);
});

describe("the socket", () => {
  let dir = "";
  let socket = "";
  let seen: SecretsRequest[] = [];
  let close = () => {};
  beforeEach(async () => {
    // short: a unix socket path has a 104-byte limit on macOS
    dir = await mkdtemp("/tmp/cs-");
    socket = join(dir, "s.sock");
    seen = [];
    const handle = async (r: SecretsRequest): Promise<SecretsReply> => {
      seen.push(r);
      return { ok: true, data: { t: r.t } };
    };
    const server = await serve({ handle }, socket);
    close = () => server.close();
  });
  afterEach(async () => {
    close();
    await rm(dir, { recursive: true, force: true });
  });

  test("one request, one reply", async () => {
    expect(await askSecrets(socket, { t: "info", token: null })).toEqual({ ok: true, data: { t: "info" } });
    expect(seen).toEqual([{ t: "info", token: null }]);
  });

  test("a line that is not a request is answered with an error and never handled", async () => {
    const reply = await new Promise<string>((resolve) => {
      const c = connect(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write('{"t":"dump"}\n'));
      c.on("data", (d: string) => (buf += d));
      c.on("close", () => resolve(buf));
    });
    expect(JSON.parse(reply)).toEqual({ ok: false, error: "unknown request dump" });
    expect(seen).toEqual([]);
  });

  test("a line over the limit is cut off", async () => {
    const reply = await new Promise<string>((resolve) => {
      const c = connect(socket);
      let buf = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write("x".repeat(LIMITS.line + 10)));
      c.on("data", (d: string) => (buf += d));
      c.on("close", () => resolve(buf));
      c.on("error", () => resolve(buf));
    });
    expect(reply).toContain("too long");
  });

  test("no service: the client says so", async () => {
    expect(await askSecrets(join(dir, "none.sock"), { t: "info", token: null })).toEqual({ ok: false, error: SECRETS_AWAY });
  });
});
