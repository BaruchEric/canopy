/* The People view (FR-074): who is on each backend, what each may do, the
   teams, the invites that sign people in and who did what. A member and a
   viewer read it; an owner or an admin changes it. The rules are the
   backend's (src/core/people.ts); this file shows them and asks. */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { mayGrant, ROLE_WORDS, type ActivityLine, type PersonHere, type Role, type Team } from "../../../src/core/people";
import { api } from "../api";
import { managesPeople, originOf } from "../callerToken";
import { expiresWords, faceOf, focusFor, grantable, inviteLink, nameOf, type Roster } from "../people";
import { baseOf, qual } from "../registry";
import { copyText } from "../share";
import { useStore } from "../store";
import { Avatar } from "./PeopleChip";
import { useNow } from "./Registry";
import { Seg } from "./Seg";
import { useRepoNames } from "./WorkSheet";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** runs a write, shows why it failed under the section, and says while it runs */
function useAsk(): { busy: boolean; err: string | null; ask: (fn: () => Promise<unknown>) => void; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ask = useCallback((fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    fn()
      .catch((e: unknown) => setErr(errText(e)))
      .finally(() => setBusy(false));
  }, []);
  return { busy, err, ask, clear: () => setErr(null) };
}

/** a button that asks twice before it does something that cannot be taken back */
function Sure({ label, title, disabled, onSure }: { label: string; title: string; disabled: boolean; onSure: () => void }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);
  return (
    <button type="button" className={sure ? "mini confirm" : "mini"} disabled={disabled} title={sure ? "Press again to do it" : title} onClick={() => (sure ? (setSure(false), onSure()) : setSure(true))}>
      {sure ? `${label}?` : label}
    </button>
  );
}

/** An invite just made: the link and the CLI's line, shown this once. The
 *  copy is kept off canopy's shared clipboard, which every hand reads. */
function InviteCard({ backend, name, code, expires, onDone }: { backend: string; name: string; code: string; expires: number; onDone: () => void }) {
  const now = useNow(60_000);
  const link = inviteLink(originOf(baseOf(backend)), code);
  const [copied, setCopied] = useState(false);
  return (
    <div className="people-invite" role="status">
      <p className="people-invite-head">
        Invite for {name}, good once, {expiresWords(expires, now)}. It is shown this once: send it to them now.
      </p>
      <code className="people-invite-link">{link}</code>
      <p className="people-invite-cli">
        or from a shell: <code>canopy auth join {code}</code>
      </p>
      <div className="people-row-acts">
        <button
          type="button"
          className="mini strong"
          onClick={() => {
            void copyText(link, { keep: false }).then(() => setCopied(true));
          }}
        >
          {copied ? "copied" : "copy the link"}
        </button>
        <button type="button" className="mini" onClick={onDone}>
          done
        </button>
      </div>
    </div>
  );
}

interface Shown {
  name: string;
  code: string;
  expires: number;
}

/** one person's row: who they are, what they hold, where they are, and what an admin may do to them */
function PersonRow({ backend, person, roster, me, mine, manage, repoName, onInvite }: { backend: string; person: PersonHere; roster: Roster; me: boolean; mine: Role | undefined; manage: boolean; repoName: (id: string) => string; onInvite: (s: Shown) => void }) {
  const now = useNow(60_000);
  const { busy, err, ask } = useAsk();
  const store = useStore.getState();
  // an admin changes nobody who outranks them, and nobody turns themselves off
  const mayChange = manage && mine !== undefined && mayGrant(mine, person.role) && person.id !== "owner";
  const roles = grantable(mine);
  const waiting = roster.invites.filter((i) => i.person === person.id);
  const soonest = waiting.reduce<number | null>((min, i) => (min === null || i.expires < min ? i.expires : min), null);
  const where = person.at.map((id) => repoName(qual(backend, id)));
  const state = person.off
    ? "off"
    : person.devices.length > 0
      ? `on ${person.devices.map((d) => d.name).join(", ")}${where.length ? `, in ${where.join(", ")}` : ""}`
      : "not on now";
  return (
    <li className={`people-row${person.off ? " off" : ""}`}>
      <Avatar face={faceOf(person)} on={person.devices.length > 0 && !person.off} />
      <div className="people-who">
        <span className="people-name">
          {person.name}
          {me && <span className="device-tag">you</span>}
        </span>
        <span className={`people-state${person.devices.length > 0 && !person.off ? " here" : ""}`}>{state}</span>
        {(person.invited > 0 || waiting.length > 0) && (
          <span className="people-state">
            {Math.max(person.invited, waiting.length)} invite{Math.max(person.invited, waiting.length) === 1 ? "" : "s"} waiting{soonest !== null ? `, ${expiresWords(soonest, now)}` : ""}
          </span>
        )}
      </div>
      <div className="people-holds">
        {mayChange ? (
          <select
            className="settings-input people-role"
            value={person.role}
            disabled={busy}
            aria-label={`${person.name}'s role`}
            title={ROLE_WORDS[person.role]}
            onChange={(e) => {
              const role = roles.find((r) => r === e.target.value);
              if (role) ask(() => store.setPerson(backend, person.id, { role }));
            }}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        ) : (
          <span className={`people-role-word role-${person.role}`} title={ROLE_WORDS[person.role]}>
            {person.role}
          </span>
        )}
        {roster.teams.length > 0 && (
          <span className="people-teams">
            {roster.teams.map((t) => {
              const on = person.teams.includes(t.id);
              if (!mayChange) return on ? <span key={t.id} className="people-team on">{t.name}</span> : null;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={on ? "people-team on" : "people-team"}
                  aria-pressed={on}
                  disabled={busy}
                  title={on ? `Take ${person.name} off ${t.name}` : `Put ${person.name} on ${t.name}`}
                  onClick={() => ask(() => store.setPerson(backend, person.id, { teams: on ? person.teams.filter((x) => x !== t.id) : [...person.teams, t.id] }))}
                >
                  {on ? t.name : `+ ${t.name}`}
                </button>
              );
            })}
          </span>
        )}
      </div>
      {mayChange && (
        <div className="people-row-acts">
          {!person.off && (
            <button type="button" className="mini" disabled={busy} title={`A new invite for ${person.name}: a link that signs one browser or CLI in as them, good once`} onClick={() => ask(async () => onInvite({ name: person.name, ...(await store.invitePerson(backend, person.id)) }))}>
              invite
            </button>
          )}
          {waiting.length > 0 && (
            <button type="button" className="mini" disabled={busy} title={`Drop the invites still waiting for ${person.name}`} onClick={() => ask(() => store.uninvitePerson(backend, person.id))}>
              drop invites
            </button>
          )}
          {!me && (
            <button
              type="button"
              className="mini"
              disabled={busy}
              title={person.off ? `Let ${person.name} back: they sign in again with a new invite` : `Sign ${person.name} out of every browser, CLI and shell, and hold them off until turned on again`}
              onClick={() => ask(() => store.setPerson(backend, person.id, { off: !person.off }))}
            >
              {person.off ? "turn on" : "turn off"}
            </button>
          )}
          {!me && <Sure label="remove" title={`Remove ${person.name}: their sessions, their shells' tokens and their invites go with them`} disabled={busy} onSure={() => ask(() => store.removePerson(backend, person.id))} />}
        </div>
      )}
      {err && <p className="people-err">{err}</p>}
    </li>
  );
}

/** the form that adds a person, with their first invite */
function AddPerson({ backend, roster, mine, onInvite }: { backend: string; roster: Roster; mine: Role | undefined; onInvite: (s: Shown) => void }) {
  const roles = grantable(mine);
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [teams, setTeams] = useState<string[]>([]);
  const { busy, err, ask } = useAsk();
  const send = () => {
    if (!name.trim()) return;
    ask(async () => {
      const made = await useStore.getState().addPerson(backend, { name, role, teams, invite: true });
      setName("");
      setTeams([]);
      if (made.invite) onInvite({ name: made.name, ...made.invite });
    });
  };
  return (
    <form
      className="people-add"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <input className="settings-input people-add-name" value={name} disabled={busy} maxLength={40} placeholder="a name: Avery" aria-label="The new person's name" onChange={(e) => setName(e.target.value)} />
      <select className="settings-input people-role" value={role} disabled={busy} aria-label="Their role" title={ROLE_WORDS[role]} onChange={(e) => setRole(roles.find((r) => r === e.target.value) ?? "member")}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      {roster.teams.length > 0 && (
        <span className="people-teams">
          {roster.teams.map((t) => {
            const on = teams.includes(t.id);
            return (
              <button key={t.id} type="button" className={on ? "people-team on" : "people-team"} aria-pressed={on} disabled={busy} title={on ? `They start on ${t.name}` : `Put them on ${t.name}`} onClick={() => setTeams(on ? teams.filter((x) => x !== t.id) : [...teams, t.id])}>
                {on ? t.name : `+ ${t.name}`}
              </button>
            );
          })}
        </span>
      )}
      <button type="submit" className="mini strong" disabled={busy || !name.trim()} title="Add them and make their first invite">
        add and invite
      </button>
      <p className="settings-hint people-add-hint">
        {role}: {ROLE_WORDS[role]}.
      </p>
      {err && <p className="people-err">{err}</p>}
    </form>
  );
}

const foldersOf = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((f) => f.trim())
    .filter(Boolean);

/** one team: its name, the folders it works in and who is on it; an admin edits the first two */
function TeamRow({ backend, team, roster, manage }: { backend: string; team: Team; roster: Roster; manage: boolean }) {
  const [name, setName] = useState(team.name);
  const [folders, setFolders] = useState(team.folders.join(", "));
  const { busy, err, ask } = useAsk();
  // another page's change shows here unless this one is mid-edit
  useEffect(() => setName(team.name), [team.name]);
  useEffect(() => setFolders(team.folders.join(", ")), [team.folders]);
  const on = roster.people.filter((p) => p.teams.includes(team.id));
  const dirty = name.trim() !== team.name || foldersOf(folders).join("\n") !== team.folders.join("\n");
  const store = useStore.getState();
  if (!manage) {
    return (
      <li className="people-team-row">
        <span className="people-name">{team.name}</span>
        <span className="people-state">{on.length ? on.map((p) => p.name).join(", ") : "nobody yet"}</span>
        {team.folders.length > 0 && <code className="people-folders">{team.folders.join("  ")}</code>}
      </li>
    );
  }
  return (
    <li className="people-team-row">
      <input className="settings-input people-team-name" value={name} disabled={busy} maxLength={40} aria-label="The team's name" onChange={(e) => setName(e.target.value)} />
      <input
        className="settings-input people-team-folders"
        value={folders}
        disabled={busy}
        spellCheck={false}
        placeholder="folders its people see first: /srv/rio, /srv/clms"
        aria-label={`The folders ${team.name} works in, as absolute paths on this backend`}
        onChange={(e) => setFolders(e.target.value)}
      />
      <span className="people-state">{on.length ? on.map((p) => p.name).join(", ") : "nobody yet"}</span>
      <div className="people-row-acts">
        <button type="button" className="mini strong" disabled={busy || !dirty || !name.trim()} onClick={() => ask(() => store.saveTeam(backend, { id: team.id, name: name.trim(), folders: foldersOf(folders) }))}>
          save
        </button>
        <Sure label="remove" title={`Remove ${team.name}; its people stay`} disabled={busy} onSure={() => ask(() => store.removeTeam(backend, team.id))} />
      </div>
      {err && <p className="people-err">{err}</p>}
    </li>
  );
}

function AddTeam({ backend }: { backend: string }) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState("");
  const { busy, err, ask } = useAsk();
  return (
    <form
      className="people-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return;
        ask(async () => {
          await useStore.getState().saveTeam(backend, { name: name.trim(), folders: foldersOf(folders) });
          setName("");
          setFolders("");
        });
      }}
    >
      <input className="settings-input people-add-name" value={name} disabled={busy} maxLength={40} placeholder="a team: Rio" aria-label="The new team's name" onChange={(e) => setName(e.target.value)} />
      <input className="settings-input people-team-folders" value={folders} disabled={busy} spellCheck={false} placeholder="its folders, as absolute paths: /srv/rio" aria-label="The folders the new team works in" onChange={(e) => setFolders(e.target.value)} />
      <button type="submit" className="mini strong" disabled={busy || !name.trim()}>
        add team
      </button>
      {err && <p className="people-err">{err}</p>}
    </form>
  );
}

/** who did what, newest first; read when the view opens, when the roster moves and on its button */
function Activity({ backend, roster }: { backend: string; roster: Roster }) {
  const [lines, setLines] = useState<ActivityLine[] | null>(null);
  const [who, setWho] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const runs = useStore((s) => s.runs.length);
  const read = useCallback(() => {
    api
      .peopleActivity(backend, who || undefined)
      .then((got) => {
        setLines(got);
        setErr(null);
      })
      .catch((e: unknown) => setErr(errText(e)));
  }, [backend, who]);
  // a run starting or ending is the commonest thing worth a new read
  useEffect(read, [read, runs, roster.people.length]);
  return (
    <section className="work-group">
      <h3 className="panel-label">
        Who did what
        <span className="people-row-acts">
          <select className="settings-input people-role" value={who} aria-label="Only one person's lines" onChange={(e) => setWho(e.target.value)}>
            <option value="">everyone</option>
            {roster.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="mini" onClick={read}>
            read again
          </button>
        </span>
      </h3>
      {err && <p className="people-err">{err}</p>}
      {lines !== null && lines.length === 0 && <p className="work-empty">Nothing yet. A run started, a shell opened, a commit, a push, a landing and each change to the people leave a line here.</p>}
      {lines !== null && lines.length > 0 && (
        <ul className="people-log">
          {lines.map((l, i) => (
            <li key={`${l.at}-${i}`}>
              <time dateTime={new Date(l.at).toISOString()} title={new Date(l.at).toLocaleString()}>
                {new Date(l.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </time>
              <span className="people-log-who">{nameOf(roster.people, l.person)}</span>
              <span>
                {l.what}
                {l.repo ? ` in ${l.repo}` : ""}
                {l.kind !== "page" && <span className="device-tag"> {l.kind}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** this page's own person: the name and colour they may change, and the way out */
function Me({ backend, roster }: { backend: string; roster: Roster }) {
  const auth = useStore((s) => s.authByBackend[backend]);
  const me = roster.people.find((p) => p.id === auth?.person?.id);
  const [name, setName] = useState(me?.name ?? "");
  const { busy, err, ask } = useAsk();
  useEffect(() => setName(me?.name ?? ""), [me?.name]);
  if (!auth || !me) return null;
  const store = useStore.getState();
  const focus = focusFor(roster, me.id);
  return (
    <section className="work-group">
      <h3 className="panel-label">You</h3>
      <div className="people-me">
        <Avatar face={faceOf(me)} on />
        <input className="settings-input people-add-name" value={name} disabled={busy} maxLength={40} aria-label="Your name on this backend" onChange={(e) => setName(e.target.value)} />
        <label className="people-hue">
          <span>colour</span>
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={faceOf(me).hue}
            disabled={busy}
            title="The colour your face wears on everyone's page"
            onChange={(e) => {
              const color = Number(e.target.value);
              ask(() => store.setMe(backend, { color }));
            }}
          />
        </label>
        <button type="button" className="mini strong" disabled={busy || !name.trim() || name.trim() === me.name} onClick={() => ask(() => store.setMe(backend, { name: name.trim() }))}>
          save
        </button>
        {auth.hasToken && auth.you === "page" && <Sure label="sign out" title="End this browser's session here. Signing in again takes an invite or an approval" disabled={busy} onSure={() => ask(() => store.signOut(backend))} />}
      </div>
      <p className="settings-hint">
        {me.role}: {ROLE_WORDS[me.role]}.{focus.length > 0 ? ` Your teams work in ${focus.join(", ")}.` : ""}
      </p>
      {err && <p className="people-err">{err}</p>}
    </section>
  );
}

function BackendPeople({ backend }: { backend: string }) {
  const roster = useStore((s) => s.people[backend]);
  const auth = useStore((s) => s.authByBackend[backend]);
  const repoName = useRepoNames();
  const [shown, setShown] = useState<Shown | null>(null);
  const loadPeople = useStore((s) => s.loadPeople);
  // the invites are an admin's read and ride no event, so the view asks on opening
  useEffect(() => void loadPeople(backend), [backend, loadPeople]);
  if (!roster) {
    return (
      <section className="work-group">
        <h3 className="panel-label">People</h3>
        <p className="work-empty">{auth?.you === "none" && auth.mode === "enforce" ? "Sign in to see who is here." : "This backend is from before there were people, or has not answered yet."}</p>
      </section>
    );
  }
  const manage = managesPeople(auth);
  const mine = auth?.person?.role;
  const me = auth?.person?.id;
  let note: ReactNode = null;
  if (!manage && auth?.you === "none") {
    note = (
      <p className="settings-hint warn">
        This page is not signed in, so it changes no one: adding a person, a team or an invite takes a signed-in owner or admin, even where the backend only logs who calls it. Sign this browser in with <code>canopy auth</code>'s first code or a pair
        approved from a signed-in page.
      </p>
    );
  }
  return (
    <>
      <Me backend={backend} roster={roster} />
      <section className="work-group">
        <h3 className="panel-label">
          People <span className="work-count">{roster.people.length}</span>
        </h3>
        {note}
        {shown && <InviteCard backend={backend} {...shown} onDone={() => setShown(null)} />}
        <ul className="people-list">
          {roster.people.map((p) => (
            <PersonRow key={p.id} backend={backend} person={p} roster={roster} me={p.id === me} mine={mine} manage={manage} repoName={repoName} onInvite={setShown} />
          ))}
        </ul>
        {manage && <AddPerson backend={backend} roster={roster} mine={mine} onInvite={setShown} />}
      </section>
      <section className="work-group">
        <h3 className="panel-label">
          Teams <span className="work-count">{roster.teams.length}</span>
        </h3>
        <p className="settings-hint">A team is a name, its people and the folders they work in. The folders set what a person's page shows first. They are not a wall: everyone on a backend acts as the one OS user canopy runs as, so a separate backend is what keeps two groups apart.</p>
        {roster.teams.length > 0 && (
          <ul className="people-list">
            {roster.teams.map((t) => (
              <TeamRow key={t.id} backend={backend} team={t} roster={roster} manage={manage} />
            ))}
          </ul>
        )}
        {manage && <AddTeam backend={backend} />}
      </section>
      <Activity backend={backend} roster={roster} />
    </>
  );
}

export function PeopleView() {
  const { order, home } = useStore(useShallow((s) => ({ order: s.backendOrder, home: s.home })));
  const [picked, setPicked] = useState<string | null>(null);
  const backend = picked !== null && order.includes(picked) ? picked : home;
  const options = useMemo(() => order.map((b) => ({ value: b, label: b })), [order]);
  return (
    <main className="health-view work-view people-view">
      {order.length > 1 && (
        <div className="work-bar">
          <Seg label="Which backend's people" value={backend} options={options} onChange={setPicked} />
          <span className="work-count">each backend keeps its own people</span>
        </div>
      )}
      <BackendPeople key={backend} backend={backend} />
    </main>
  );
}
