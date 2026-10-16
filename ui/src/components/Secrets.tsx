import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState, type FormEvent } from "react";
import type { SecretAct } from "../../../src/core/secretwire";
import type { SecretAuditEntry, SecretMeta, SecretProposalInfo, SecretRestartResult, SecretSinkFormat, SecretSinkInfo, SecretsInfo } from "../../../src/core/types";
import { api } from "../api";
import { KEY_TONE, errorText, filterSecrets, gateHere, hostOf, isGateClosed, keysText, markOf, parseKeysText, passedOver, reachRows, sinkRows, stateTone, tagsOf, usedByText, writerOf, type ReachRow, type SinkRow, type WriteMark } from "../secrets";
import { reachRefusal } from "../../../src/core/secretfile";
import { bulkAct, pick } from "../secretsbulk";
import { newKeyProblem } from "../secretsform";
import { useStore } from "../store";
import { ago } from "../util";

type AuthOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];
type RegOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type Tab = "secrets" | "sinks" | "import" | "passkeys";

const since = (iso: string): string => ago(Date.parse(iso) / 1000);
const words = (text: string): string[] =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
const MACHINES = ["mini", "mac", "gpd"] as const;

function Err({ text }: { text: string | null }) {
  return text ? (
    <span className="secrets-err" role="alert">
      {text}
    </span>
  ) : null;
}

async function login(b: string): Promise<void> {
  const options = await api.secretsBegin(b, "login", null);
  const response = await startAuthentication({ optionsJSON: options as AuthOptions });
  await api.secretsFinish(b, "login", null, response, "");
}

async function register(b: string, code: string | null, label: string): Promise<void> {
  const options = await api.secretsBegin(b, "register", code);
  const response = await startRegistration({ optionsJSON: options as RegOptions });
  await api.secretsFinish(b, "register", code, response, label);
}

/** one gated act at a time on `b`, its error kept for the form that asked;
 *  null when it failed */
function useAct(b: string) {
  const load = useStore((s) => s.loadSecrets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: SecretAct): Promise<{ data: unknown } | null> => {
    setBusy(true);
    setError(null);
    try {
      return { data: await api.secretsAct(b, act) };
    } catch (e) {
      if (isGateClosed(e)) {
        setError("the passkey session has ended; open it again above");
        void load(b);
      } else setError(errorText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

/** a step that reloads the store's info however it ends */
function useStep(b: string) {
  const load = useStore((s) => s.loadSecrets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = async (fn: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
      void load(b);
    }
  };
  return { busy, error, setError, step };
}

export function SecretsView() {
  const all = useStore((s) => s.secrets);
  const home = useStore((s) => s.home);
  const order = useStore((s) => s.backendOrder);
  const load = useStore((s) => s.loadSecrets);
  const [tab, setTab] = useState<Tab>("secrets");
  useEffect(() => {
    for (const b of order) void load(b);
  }, [order, load]);
  const info = all[home];
  if (!info) {
    return (
      <main className="secrets-view">
        <p className="secrets-note">Reading the secret store…</p>
      </main>
    );
  }
  const here = gateHere(info, window.location.origin);
  const open = here && info.session;
  const writer = writerOf(all, order);
  const tabs: Tab[] = here ? ["secrets", "sinks", "import", "passkeys"] : ["secrets", "sinks", "import"];
  const shown = tabs.includes(tab) ? tab : "secrets";
  return (
    <main className="secrets-view">
      <div className="secrets-bar">
        <span className="secrets-head">
          {info.role === "writer" ? "the mini's store" : `${info.backend}'s pulled copy`} · {info.head ?? "no commit yet"} · {info.secrets.length} secrets
          {info.unpushed > 0 && <span className="lichen"> · {info.unpushed} not on Forgejo yet</span>}
        </span>
        {here ? <PasskeyGate info={info} home={home} /> : info.role === "reader" ? <MachineKey info={info} home={home} /> : null}
        {!here && hostOf(info.gate) !== "" && (
          <a className="chip" href={info.gate}>
            gated actions live on {hostOf(info.gate)}
          </a>
        )}
      </div>
      {!info.ok && (
        <p className="secrets-err" role="alert">
          {info.error}
        </p>
      )}
      {info.refused && (
        <p className="secrets-err" role="alert">
          The newest commit was refused: {info.refused}. This page reads {info.head ?? "nothing yet"}.
        </p>
      )}
      <div className="seg secrets-tabs" role="radiogroup" aria-label="Secret store sections">
        {tabs.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={shown === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {shown === "secrets" ? (
        <SecretsTab info={info} home={home} open={open} sinks={sinkRows(all, order, writer)} all={all} />
      ) : shown === "sinks" ? (
        <SinksTab rows={sinkRows(all, order, writer)} home={home} writer={writer} open={open} />
      ) : shown === "import" ? (
        <ImportTab info={info} home={home} writer={writer} here={here} open={open} />
      ) : (
        <PasskeysTab info={info} home={home} open={open} />
      )}
    </main>
  );
}

/** the gate page's passkey: the first one with the printed code, then a
 *  session to open or close */
function PasskeyGate({ info, home }: { info: SecretsInfo; home: string }) {
  const { busy, error, step } = useStep(home);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  if (info.firstPasskey) {
    return (
      <form
        className="secrets-form"
        onSubmit={(e) => {
          e.preventDefault();
          void step(async () => {
            await register(home, code.trim(), label);
            await login(home);
          }).then((ok) => ok && setCode(""));
        }}
      >
        <span>No passkey yet. The code is in the secrets service's log.</span>
        <input aria-label="First-passkey code" placeholder="code" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
        <input aria-label="Passkey label" placeholder="label, e.g. phone" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit" className="mini" disabled={busy || code.trim() === ""}>
          register
        </button>
        <Err text={error} />
      </form>
    );
  }
  return (
    <span className="secrets-gate">
      {info.session ? (
        <>
          <span className="moss">session open</span>
          <button type="button" className="mini" disabled={busy} onClick={() => void step(async () => void (await api.secretsLogout(home)))}>
            close
          </button>
        </>
      ) : (
        <button type="button" className="mini" disabled={busy} onClick={() => void step(() => login(home))}>
          open with a passkey
        </button>
      )}
      <Err text={error} />
    </span>
  );
}

/** a reader's own age key: unlock, lock, or make one */
function MachineKey({ info, home }: { info: SecretsInfo; home: string }) {
  const { busy, error, setError, step } = useStep(home);
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [recipient, setRecipient] = useState<string | null>(null);
  const forget = () => {
    setPass("");
    setAgain("");
  };
  if (recipient) {
    return (
      <span className="secrets-gate">
        Key made. Add it on the gate page under passkeys, machine keys:
        <code className="secrets-recipient">{recipient}</code>
        <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(recipient)}>
          copy
        </button>
        <button type="button" className="mini" onClick={() => setRecipient(null)}>
          done
        </button>
      </span>
    );
  }
  if (info.lock === "open") {
    return (
      <span className="secrets-gate">
        <span className="moss">this machine's key is open</span>
        {info.recipient && (
          <>
            <code className="secrets-recipient">{info.recipient}</code>
            <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(info.recipient ?? "")}>
              copy
            </button>
          </>
        )}
        <button type="button" className="mini" disabled={busy} onClick={() => void step(async () => void (await api.secretsLock(home)))}>
          lock
        </button>
        <Err text={error} />
      </span>
    );
  }
  if (info.lock === "locked") {
    return (
      <form
        className="secrets-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void step(async () => void (await api.secretsUnlock(home, pass))).then(forget);
        }}
      >
        <input type="password" aria-label="This machine's key passphrase" placeholder="key passphrase" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
        <button type="submit" className="mini" disabled={busy || pass === ""}>
          unlock
        </button>
        <Err text={error} />
      </form>
    );
  }
  return (
    <form
      className="secrets-form"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        const problem = newKeyProblem(pass, again);
        if (problem) {
          setError(problem);
          return;
        }
        void step(async () => {
          const k = await api.secretsKey(home, pass, false);
          setRecipient(k.recipient);
        }).then(forget);
      }}
    >
      <span>No key on this machine.</span>
      <input type="password" aria-label="New key passphrase, 12 characters or more" placeholder="passphrase, 12 or more characters" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
      <input type="password" aria-label="The passphrase again" placeholder="the same again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      <button type="submit" className="mini" disabled={busy || pass === ""}>
        make a key
      </button>
      <Err text={error} />
    </form>
  );
}

function SecretsTab({ info, home, open, sinks, all }: { info: SecretsInfo; home: string; open: boolean; sinks: SinkRow[]; all: Readonly<Record<string, SecretsInfo>> }) {
  const [text, setText] = useState("");
  const [tag, setTag] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const shown = filterSecrets(info.secrets, text, tag);
  return (
    <section className="secrets-tab">
      <div className="secrets-filter">
        <input type="search" aria-label="Filter secrets" placeholder="filter by name, description or tag" value={text} onChange={(e) => setText(e.target.value)} />
        {tagsOf(info.secrets).map((t) => (
          <button key={t} type="button" className={`chip${tag === t ? " on" : ""}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
            {t}
          </button>
        ))}
      </div>
      {open && <AddSecret home={home} />}
      <ul className="secrets-list">
        {shown.map((m) => (
          <li key={m.name}>
            <button type="button" className="secrets-row" aria-expanded={picked === m.name} onClick={() => setPicked(picked === m.name ? null : m.name)}>
              <span className="secrets-name">{m.name}</span>
              <span className="secrets-desc">{m.description}</span>
              <span className="secrets-meta">
                rotated {since(m.rotated)} · {m.to.join(", ")}
                {m.usedBy.length > 0 ? ` · ${m.usedBy.length} sink${m.usedBy.length === 1 ? "" : "s"}` : ""}
                {m.tags.length > 0 ? ` · ${m.tags.join(", ")}` : ""}
              </span>
            </button>
            {picked === m.name && <SecretSheet key={m.name} meta={m} home={home} open={open} sinks={sinks} all={all} />}
          </li>
        ))}
      </ul>
      {shown.length === 0 && <p className="secrets-note">{info.secrets.length === 0 ? "No secrets yet." : "Nothing matches."}</p>}
    </section>
  );
}

function AddSecret({ home }: { home: string }) {
  const act = useAct(home);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run({ a: "add", name: name.trim(), value, description: description.trim(), tags: words(tags) });
    setValue("");
    if (r) {
      setName("");
      setDescription("");
      setTags("");
    }
  };
  return (
    <form className="secrets-form" onSubmit={(e) => void submit(e)}>
      <input aria-label="New secret name" placeholder="name, e.g. cf_token" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
      <input type="password" aria-label="New secret value" placeholder="value" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
      <input aria-label="Description" placeholder="what it is for" value={description} onChange={(e) => setDescription(e.target.value)} />
      <input aria-label="Tags, comma separated" placeholder="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
      <button type="submit" className="mini" disabled={act.busy || name.trim() === "" || value === ""}>
        add
      </button>
      <Err text={act.error} />
    </form>
  );
}

/** A rotation's reach. With `restartOn` (the gate page, a session open) a
 *  stack row gets a restart button, enabled once its sinks have written,
 *  and shows each container's state after it. */
function ReachList({ rows, restartOn }: { rows: ReachRow[]; restartOn?: string }) {
  const act = useAct(restartOn ?? "");
  const [done, setDone] = useState<Record<string, SecretRestartResult>>({});
  const [asked, setAsked] = useState<string | null>(null);
  if (rows.length === 0) return <p className="secrets-note">Nothing uses it; a rotation changes only the store.</p>;
  const restart = async (project: string) => {
    setAsked(null);
    const r = await act.run({ a: "stack-restart", project });
    const d = r?.data as SecretRestartResult | undefined;
    if (d && Array.isArray(d.containers)) setDone((x) => ({ ...x, [project]: d }));
  };
  return (
    <ul className="secrets-reach">
      {rows.map((r) => (
        <li key={`${r.kind}:${r.name}`}>
          <span className="secrets-reach-kind">{r.kind}</span> <strong>{r.name}</strong>
          {r.machine ? ` on ${r.machine}` : ""}
          {r.kind === "stack" ? (
            <>
              {" "}
              <code>{r.detail}</code>{" "}
              {r.detail.startsWith("docker ") && (
                <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(r.detail)}>
                  copy
                </button>
              )}
              {restartOn && asked !== r.name && (
                <button
                  type="button"
                  className="mini"
                  disabled={act.busy || !r.ready}
                  title={r.ready ? `docker compose up -d for ${r.name} on the mini` : "waits until every sink that restarts it has written the new value"}
                  onClick={() => setAsked(r.name)}
                >
                  restart…
                </button>
              )}
              {restartOn && asked === r.name && (
                <>
                  <span className="rust">Restart {r.name}?</span>{" "}
                  <button type="button" className="mini" disabled={act.busy} onClick={() => void restart(r.name)}>
                    {act.busy ? "restarting…" : "restart"}
                  </button>
                  <button type="button" className="mini" disabled={act.busy} onClick={() => setAsked(null)}>
                    keep it running
                  </button>
                </>
              )}
              {done[r.name] && (
                <span className="secrets-note">
                  {" "}
                  · {done[r.name]?.containers.map((c) => `${c.service} ${c.state}${c.health ? ` (${c.health})` : ""}`).join(", ") || "no containers"}
                </span>
              )}
            </>
          ) : r.detail ? (
            <span className="secrets-note"> · {r.detail}</span>
          ) : null}
          {r.state ? <span className={stateTone(r.state)}> · {r.state}</span> : null}
        </li>
      ))}
      {act.error && (
        <li>
          <Err text={act.error} />
        </li>
      )}
    </ul>
  );
}

/** one secret opened: its facts for anyone, and behind the session its
 *  value (shown for 20 s), its words, a new value, its allowlist, delete
 *  and its history */
function SecretSheet({ meta, home, open, sinks, all }: { meta: SecretMeta; home: string; open: boolean; sinks: SinkRow[]; all: Readonly<Record<string, SecretsInfo>> }) {
  const act = useAct(home);
  const [shown, setShown] = useState<{ value: string; until: number } | null>(null);
  const [description, setDescription] = useState(meta.description);
  const [tags, setTags] = useState(meta.tags.join(", "));
  const [allow, setAllow] = useState(meta.allow.join("\n"));
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [reach, setReach] = useState<"no" | "preview" | "after">("no");
  const [mark, setMark] = useState<WriteMark | null>(null);
  const writerInfo = Object.values(all).find((i) => i.role === "writer");
  const rows = reachRows(meta, sinks, reach === "after" ? (owner) => !passedOver(mark, owner, owner === null ? undefined : all[owner]) : undefined, writerInfo?.stacks);
  const [history, setHistory] = useState<SecretAuditEntry[]>([]);
  // a rotation from anywhere makes a revealed value stale
  useEffect(() => {
    setShown(null);
  }, [meta.rotated]);
  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), Math.max(0, shown.until - Date.now()));
    return () => clearTimeout(t);
  }, [shown]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.secretsAudit(home).then(
      (list) => live && setHistory(list.filter((h) => h.name === meta.name).slice(0, 20)),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, home, meta.name]);
  const reveal = async () => {
    const r = await act.run({ a: "reveal", name: meta.name });
    const d = r?.data as { value?: unknown; hideAfterMs?: unknown } | null | undefined;
    if (d && typeof d.value === "string") setShown({ value: d.value, until: Date.now() + (typeof d.hideAfterMs === "number" ? d.hideAfterMs : 20_000) });
  };
  const used = meta.impact ? meta.impact.sinks.length + meta.impact.servers.length > 0 : meta.usedBy.length > 0;
  const usedTitle = meta.impact ? reachRefusal(meta.name, meta.impact) : `used by ${meta.usedBy.join(", ")}; take it out of those sinks first`;
  return (
    <div className="secrets-sheet">
      <dl className="secrets-facts">
        <dt>created</dt>
        <dd>{since(meta.created)}</dd>
        <dt>rotated</dt>
        <dd>{since(meta.rotated)}</dd>
        <dt>sealed to</dt>
        <dd>{meta.to.join(", ") || "nobody"}</dd>
        <dt>used by</dt>
        <dd>{usedByText(meta)}</dd>
        <dt>allowed</dt>
        <dd>{meta.allow.join(", ") || "nothing"}</dd>
      </dl>
      {!open ? (
        <p className="secrets-note">Reveal, rotate and edit need a passkey session on the gate page.</p>
      ) : (
        <>
          <div className="secrets-line">
            <code className="secrets-value">{shown ? shown.value : "••••••••"}</code>
            {shown ? (
              <>
                <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(shown.value)}>
                  copy
                </button>
                <button type="button" className="mini" onClick={() => setShown(null)}>
                  hide
                </button>
              </>
            ) : (
              <button type="button" className="mini" disabled={act.busy} onClick={() => void reveal()}>
                reveal
              </button>
            )}
          </div>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run({ a: "edit", name: meta.name, description: description.trim(), tags: words(tags) });
            }}
          >
            <input aria-label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
            <input aria-label="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy}>
              save
            </button>
          </form>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (reach !== "preview") {
                setReach("preview");
                return;
              }
              void act.run({ a: "rotate", name: meta.name, value: next }).then((r) => {
                if (r) {
                  setNext("");
                  setShown(null);
                  setMark(markOf(r.data, all));
                  setReach("after");
                }
              });
            }}
          >
            <input type="password" aria-label={`New value for ${meta.name}`} placeholder="new value" autoComplete="off" value={next} onChange={(e) => setNext(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy || next === ""}>
              {reach === "preview" ? "rotate now" : "rotate…"}
            </button>
            {reach === "preview" && (
              <button type="button" className="mini" onClick={() => setReach("no")}>
                cancel
              </button>
            )}
          </form>
          {reach === "preview" && (
            <>
              <p className="secrets-note">Rotating {meta.name} writes the new value here:</p>
              <ReachList rows={rows} />
              {writerInfo?.stacksError && <p className="secrets-note">No restart buttons: {writerInfo.stacksError}</p>}
            </>
          )}
          {reach === "after" && (
            <>
              <p className="secrets-note">Written. Each sink's state from its owner's next pass, then restart what reads it:</p>
              <ReachList rows={rows} restartOn={home} />
              {writerInfo?.stacksError && <p className="secrets-note">No restart buttons: {writerInfo.stacksError}</p>}
            </>
          )}
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              const list = allow
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean);
              void act.run({ a: "allow", name: meta.name, allow: list });
            }}
          >
            <textarea aria-label={`What may use ${meta.name}, one entry a line`} rows={3} spellCheck={false} value={allow} onChange={(e) => setAllow(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy}>
              save allowlist
            </button>
          </form>
          <div className="secrets-line">
            {confirm ? (
              <>
                <span className="rust">Delete {meta.name} for good?</span>
                <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "delete", name: meta.name })}>
                  delete
                </button>
                <button type="button" className="mini" onClick={() => setConfirm(false)}>
                  keep it
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mini"
                disabled={used}
                title={used ? usedTitle : `delete ${meta.name}`}
                onClick={() => setConfirm(true)}
              >
                delete…
              </button>
            )}
          </div>
          {used && <ReachList rows={rows} />}
          <Err text={act.error} />
          {history.length > 0 && (
            <ol className="secrets-history">
              {history.map((h, i) => (
                <li key={`${h.at}-${i}`} className={h.ok ? undefined : "rust"}>
                  {since(h.at)} · {h.action}
                  {h.by ? ` by ${h.by}` : ""}
                  {h.detail ? ` · ${h.detail}` : ""}
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function SinksTab({ rows, home, writer, open }: { rows: SinkRow[]; home: string; writer: string | null; open: boolean }) {
  const act = useAct(home);
  const [editing, setEditing] = useState<SecretSinkInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** a reader's drifted key: that backend seals the file's value to the
   *  mini, and the page hands it to the mini's proposals */
  const takeElsewhere = async (owner: string, id: string, key: string) => {
    if (!writer) {
      setNote("the mini is not answering, so nothing can be proposed to it");
      return;
    }
    try {
      const item = await api.secretsTake(owner, id, key);
      const r = await api.secretsPropose(writer, [item]);
      setNote(r.added > 0 ? "sent to the mini; approve it under import on the gate page" : "the mini dropped it; its secret may be gone");
    } catch (e) {
      setNote(errorText(e));
    }
  };
  return (
    <section className="secrets-tab">
      {open && <SinkEditor key={editing?.id ?? ""} home={home} start={editing} onDone={() => setEditing(null)} />}
      {rows.length === 0 && <p className="secrets-note">No sinks yet.</p>}
      <ul className="secrets-list">
        {rows.map(({ sink, owner }) => (
          <li key={sink.id}>
            <div className="secrets-line">
              <span className="secrets-name">{sink.id}</span>
              <span className="secrets-meta">
                {sink.machine} · {sink.path} · {sink.format}
                {sink.stack ? ` · restarts ${sink.stack}${sink.restart === undefined ? " (from its folder)" : ""}` : sink.restart === "none" ? " · restarts nothing" : ""}
                {owner === null ? " · no backend reports it" : ""}
              </span>
              {open && (
                <>
                  <button type="button" className="mini" onClick={() => setEditing(sink)}>
                    edit
                  </button>
                  <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "sink-remove", id: sink.id })}>
                    remove
                  </button>
                </>
              )}
            </div>
            {sink.error && (
              <p className="secrets-err" role="alert">
                {sink.error}
              </p>
            )}
            <ul className="secrets-keys">
              {Object.entries(sink.keys).map(([key, name]) => {
                const state = sink.state[key] ?? "unknown";
                return (
                  <li key={key}>
                    <code>{key}</code> ← {name} <span className={KEY_TONE[state]}>{state}</span>
                    {state === "drift" && owner !== null && owner === writer && open && (
                      <>
                        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "sink-write", id: sink.id, key })}>
                          write the store's value
                        </button>
                        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "take", id: sink.id, key })}>
                          take the file's value
                        </button>
                      </>
                    )}
                    {state === "drift" && owner !== null && owner !== writer && (
                      <button type="button" className="mini" onClick={() => void takeElsewhere(owner, sink.id, key)}>
                        take the file's value
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      <Err text={act.error} />
      {note && <p className="secrets-note">{note}</p>}
    </section>
  );
}

function SinkEditor({ home, start, onDone }: { home: string; start: SecretSinkInfo | null; onDone: () => void }) {
  const act = useAct(home);
  const [id, setId] = useState(start?.id ?? "");
  const [machine, setMachine] = useState(start?.machine ?? "mini");
  const [path, setPath] = useState(start?.path ?? "");
  const [format, setFormat] = useState<SecretSinkFormat>(start?.format ?? "dotenv");
  const [keys, setKeys] = useState(start ? keysText(start.keys) : "");
  const [restart, setRestart] = useState(start?.restart ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseKeysText(keys, format);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const project = restart.trim();
    const r = await act.run({ a: "sink-set", id: id.trim(), machine, path: path.trim(), format, keys: parsed, ...(project ? { restart: project } : {}) });
    if (r) {
      setId("");
      setPath("");
      setKeys("");
      onDone();
    }
  };
  return (
    <form className="secrets-form" onSubmit={(e) => void submit(e)}>
      <input aria-label="Sink id" placeholder="id, e.g. immich" spellCheck={false} value={id} readOnly={start !== null} onChange={(e) => setId(e.target.value)} />
      <select aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
        {MACHINES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
      <input aria-label="File path" placeholder="/opt/stacks/immich/.env" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
      <select aria-label="Format" value={format} onChange={(e) => setFormat(e.target.value === "json" ? "json" : "dotenv")}>
        <option value="dotenv">dotenv</option>
        <option value="json">json</option>
      </select>
      <textarea aria-label="Keys, one KEY=secret_name a line" rows={3} spellCheck={false} placeholder="DB_PASSWORD=immich_db" value={keys} onChange={(e) => setKeys(e.target.value)} />
      <input
        aria-label="Compose project a write restarts"
        placeholder={start?.stack && start.restart === undefined ? `restarts ${start.stack}, found from its folder` : "project to restart, none, or empty to find it"}
        spellCheck={false}
        value={restart}
        onChange={(e) => setRestart(e.target.value)}
      />
      <button type="submit" className="mini" disabled={act.busy || id.trim() === "" || path.trim() === ""}>
        {start ? "save sink" : "add sink"}
      </button>
      {start && (
        <button type="button" className="mini" onClick={onDone}>
          cancel
        </button>
      )}
      <Err text={error ?? act.error} />
    </form>
  );
}

function ImportTab({ info, home, writer, here, open }: { info: SecretsInfo; home: string; writer: string | null; here: boolean; open: boolean }) {
  const act = useAct(home);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const scanMini = async () => {
    const r = await act.run({ a: "import-scan" });
    const d = r?.data as { added?: unknown; dropped?: unknown } | null | undefined;
    if (d && typeof d.added === "number") setNote(`${d.added} waiting for approval${typeof d.dropped === "number" && d.dropped > 0 ? `, ${d.dropped} dropped` : ""}`);
  };
  const scanHere = async () => {
    if (!writer) {
      setNote("the mini is not answering, so nothing can be proposed to it");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const found = await api.secretsScan(home);
      const r = found.items.length > 0 ? await api.secretsPropose(writer, found.items) : { added: 0, dropped: 0 };
      const away = found.missing.length > 0 ? `; not on this machine: ${found.missing.join(", ")}` : "";
      setNote(`${found.items.length} found, ${r.added} sent to the mini${r.dropped > 0 ? `, ${r.dropped} dropped` : ""}${away}. Approve them under import on the gate page.`);
    } catch (e) {
      setNote(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="secrets-tab">
      <div className="secrets-line">
        {here ? (
          <button type="button" className="mini strong" disabled={!open || act.busy} onClick={() => void scanMini()}>
            scan the mini's sources
          </button>
        ) : (
          <button type="button" className="mini strong" disabled={busy} onClick={() => void scanHere()}>
            scan this machine's sources
          </button>
        )}
        <span className="secrets-note">Values go to the mini sealed to its key. Nothing is stored until it is approved.</span>
      </div>
      <Err text={act.error} />
      {note && <p className="secrets-note">{note}</p>}
      {here && !open && info.proposals.length > 0 && <p className="secrets-note">{info.proposals.length} waiting; open a passkey session to approve them.</p>}
      {here && open && info.proposals.length > 0 && <Bulk proposals={info.proposals} home={home} picked={picked} setPicked={setPicked} />}
      {here && open && (
        <ul className="secrets-list">
          {info.proposals.map((p) => (
            <Proposal key={p.id} p={p} home={home} picked={picked.has(p.id)} onPick={(on) => setPicked((s) => toggled(s, p.id, on))} />
          ))}
        </ul>
      )}
    </section>
  );
}

const toggled = (s: ReadonlySet<string>, id: string, on: boolean): Set<string> => {
  const next = new Set(s);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

/** Pick many proposals and approve or reject them in one go. An approve
 *  takes each one's suggested name, its stack as tag and sink; a source
 *  that only lists names still needs its value typed on its own row. */
function Bulk({ proposals, home, picked, setPicked }: { proposals: SecretProposalInfo[]; home: string; picked: ReadonlySet<string>; setPicked: (s: Set<string>) => void }) {
  const load = useStore((s) => s.loadSecrets);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const chosen = proposals.filter((p) => picked.has(p.id));
  const approvable = chosen.filter((p) => bulkAct(p) !== null);
  const run = async (verb: "approve" | "reject") => {
    setBusy(true);
    setNote(null);
    const list = verb === "approve" ? approvable : chosen;
    const failed: string[] = [];
    let done = 0;
    try {
      for (const p of list) {
        const act: SecretAct | null = verb === "approve" ? bulkAct(p) : { a: "reject", proposal: p.id };
        if (!act) continue;
        setNote(`${verb === "approve" ? "approving" : "rejecting"} ${done + failed.length + 1} of ${list.length}`);
        try {
          await api.secretsAct(home, act);
          done++;
        } catch (e) {
          if (isGateClosed(e)) {
            failed.push("the passkey session ended; open it again and pick up where this stopped");
            break;
          }
          failed.push(`${p.key}: ${errorText(e)}`);
        }
      }
    } finally {
      const skipped = verb === "approve" ? chosen.length - approvable.length : 0;
      setNote(
        `${done} ${verb === "approve" ? "approved" : "rejected"}${skipped > 0 ? `, ${skipped} left for a typed value` : ""}${failed.length > 0 ? `; ${failed.length} failed: ${failed.join("; ")}` : ""}`,
      );
      setPicked(new Set());
      setBusy(false);
      void load(home);
    }
  };
  return (
    <div className="secrets-bulk">
      <div className="secrets-line">
        <span className="secrets-note">pick</span>
        <button type="button" className="mini" disabled={busy} onClick={() => setPicked(pick(proposals, "secrets"))}>
          secret-looking
        </button>
        <button type="button" className="mini" disabled={busy} onClick={() => setPicked(pick(proposals, "settings"))}>
          setting-looking
        </button>
        <button type="button" className="mini" disabled={busy} onClick={() => setPicked(new Set(proposals.map((p) => p.id)))}>
          all
        </button>
        <button type="button" className="mini" disabled={busy || picked.size === 0} onClick={() => setPicked(pick(proposals, "none"))}>
          none
        </button>
      </div>
      <div className="secrets-line">
        <button type="button" className="mini strong" disabled={busy || approvable.length === 0} onClick={() => void run("approve")}>
          approve {approvable.length}
        </button>
        <button type="button" className="mini strong" disabled={busy || chosen.length === 0} onClick={() => void run("reject")}>
          reject {chosen.length}
        </button>
        <span className="secrets-note">
          {chosen.length} of {proposals.length} picked; the pick goes by key name, so check it before you approve. A file canopy can write becomes a sink.
        </span>
      </div>
      {note && <p className="secrets-note">{note}</p>}
    </div>
  );
}

function Proposal({ p, home, picked, onPick }: { p: SecretProposalInfo; home: string; picked: boolean; onPick: (on: boolean) => void }) {
  const act = useAct(home);
  const [name, setName] = useState(p.merges ?? p.suggested);
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [value, setValue] = useState("");
  const [asSink, setAsSink] = useState(false);
  const [sinkId, setSinkId] = useState("");
  return (
    <li>
      <div className="secrets-line">
        <input type="checkbox" aria-label={`Pick ${p.key} from ${p.source}`} checked={picked} onChange={(e) => onPick(e.target.checked)} />
        <span className="secrets-name">{p.key}</span>
        <span className="secrets-meta">
          {p.from} · {p.source}
          {p.merges ? ` · updates ${p.merges}` : ""}
          {p.same ? ` · same value as ${p.same}` : ""}
          {p.namesOnly ? " · names only" : ""}
        </span>
      </div>
      <form
        className="secrets-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act.run({
            a: "approve",
            proposal: p.id,
            name: name.trim(),
            description: description.trim(),
            tags: words(tags),
            value: p.namesOnly ? value : null,
            sink: p.sinkable && asSink && sinkId.trim() !== "" ? { id: sinkId.trim() } : null,
          });
        }}
      >
        <input aria-label="Secret name" spellCheck={false} value={name} readOnly={p.merges !== null} onChange={(e) => setName(e.target.value)} />
        {p.merges === null && (
          <>
            <input aria-label="Description" placeholder="what it is for" value={description} onChange={(e) => setDescription(e.target.value)} />
            <input aria-label="Tags, comma separated" placeholder="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
          </>
        )}
        {p.namesOnly && (
          <input type="password" aria-label={`Value for ${p.key}`} placeholder="value (this source lists names only)" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        {p.sinkable && (
          <label className="secrets-check">
            <input type="checkbox" checked={asSink} onChange={(e) => setAsSink(e.target.checked)} />
            keep this file in step as a sink
          </label>
        )}
        {p.sinkable && asSink && <input aria-label="Sink id" placeholder="sink id" spellCheck={false} value={sinkId} onChange={(e) => setSinkId(e.target.value)} />}
        <button type="submit" className="mini" disabled={act.busy || name.trim() === "" || (p.namesOnly && value === "")}>
          approve
        </button>
        <button type="button" className="mini" disabled={act.busy} onClick={() => void act.run({ a: "reject", proposal: p.id })}>
          reject
        </button>
        <Err text={act.error} />
      </form>
    </li>
  );
}

function PasskeysTab({ info, home, open }: { info: SecretsInfo; home: string; open: boolean }) {
  const act = useAct(home);
  const { busy, error, step } = useStep(home);
  const [label, setLabel] = useState("");
  const [machine, setMachine] = useState("mac");
  const [recipient, setRecipient] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const [audit, setAudit] = useState<SecretAuditEntry[]>([]);
  useEffect(() => {
    let live = true;
    api.secretsAudit(home).then(
      (list) => live && setAudit(list),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [home, info.head, info.passkeys.length, info.session]);
  return (
    <section className="secrets-tab">
      {!open ? (
        <p className="secrets-note">Open a passkey session above to add or remove passkeys and machine keys.</p>
      ) : (
        <>
          <ul className="secrets-list">
            {info.passkeys.map((k) => (
              <li key={k.id} className="secrets-line">
                {renaming === k.id ? (
                  <form
                    className="secrets-form"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault();
                      void act.run({ a: "passkey-label", id: k.id, label: newLabel }).then((r) => r && setRenaming(null));
                    }}
                  >
                    <input aria-label={`New label for ${k.label}`} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                    <button type="submit" className="mini" disabled={act.busy || newLabel.trim() === ""}>
                      save
                    </button>
                    <button type="button" className="mini" onClick={() => setRenaming(null)}>
                      cancel
                    </button>
                  </form>
                ) : (
                  <span className="secrets-name">{k.label}</span>
                )}
                <span className="secrets-meta">
                  added {since(k.created)}
                  {k.lastUsed ? ` · used ${since(k.lastUsed)}` : ""}
                </span>
                {renaming !== k.id && (
                  <button
                    type="button"
                    className="mini"
                    disabled={act.busy}
                    onClick={() => {
                      setNewLabel(k.label);
                      setRenaming(k.id);
                    }}
                  >
                    rename
                  </button>
                )}
                <button
                  type="button"
                  className="mini"
                  disabled={act.busy || info.passkeys.length <= 1}
                  title={info.passkeys.length <= 1 ? "the last passkey stays" : `remove ${k.label}`}
                  onClick={() => void act.run({ a: "passkey-remove", id: k.id })}
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void step(() => register(home, null, label)).then((ok) => ok && setLabel(""));
            }}
          >
            <input aria-label="New passkey label" placeholder="label, e.g. laptop" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="mini" disabled={busy}>
              add a passkey
            </button>
            <Err text={error} />
          </form>
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              void act.run({ a: "machine-key", machine, recipient: recipient.trim() }).then((r) => r && setRecipient(""));
            }}
          >
            <span>Machine key</span>
            <select aria-label="Machine" value={machine} onChange={(e) => setMachine(e.target.value)}>
              {MACHINES.filter((m) => m !== "mini").map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <input aria-label="Its age recipient" placeholder="age1…" spellCheck={false} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy || recipient.trim() === ""}>
              set
            </button>
            <Err text={act.error} />
          </form>
        </>
      )}
      {audit.length > 0 && (
        <ol className="secrets-history">
          {audit.map((h, i) => (
            <li key={`${h.at}-${i}`} className={h.ok ? undefined : "rust"}>
              {since(h.at)} · {h.action}
              {h.name ? ` ${h.name}` : ""}
              {h.by ? ` by ${h.by}` : ""}
              {h.detail ? ` · ${h.detail}` : ""}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
