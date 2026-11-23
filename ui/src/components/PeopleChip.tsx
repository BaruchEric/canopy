/* People in the page's own chrome (FR-074): a face, the top bar's chip of
   who is on, the faces on a repo's card, and the line that says what became
   of an invite. The People view is People.tsx, loaded when it is opened;
   what is here rides with the first screen, so it stays small. */

import { useEffect, useMemo, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { openView } from "../clirun";
import { faceOf, nameOf, othersAt, othersHere, roleLimit, type Face } from "../people";
import { backendOf, plainOf } from "../registry";
import { useStore } from "../store";

/** A person as two letters on their hue. `on` rings it: a browser of theirs
 *  is on the backend now. Decoration unless it is given words of its own. */
export function Avatar({ face, on = false, size = "md", title }: { face: Face; on?: boolean; size?: "sm" | "md"; title?: string }) {
  // a custom property is not in React's CSSProperties, so the object is cast to it
  const hue = { "--hue": face.hue } as CSSProperties;
  if (title === undefined) {
    return (
      <span className={`avatar avatar-${size}${on ? " on" : ""}`} style={hue} aria-hidden="true">
        {face.letters}
      </span>
    );
  }
  return (
    <span className={`avatar avatar-${size}${on ? " on" : ""}`} style={hue} role="img" aria-label={title} title={title}>
      {face.letters}
    </span>
  );
}

/** how many faces a chip shows before it counts the rest */
const FACES = 3;

/**
 * Who is on, in the top bar: the faces of the others with a browser on any
 * backend this page talks to, then this page's own person. Pressing it opens
 * the People view. A canopy with one person and nobody else on shows
 * nothing, since the view is in the views menu. Someone whose role only
 * reads is told so here, so a refused button has its reason on the screen.
 */
export function PeopleChip() {
  const { order, people, auths, home } = useStore(useShallow((s) => ({ order: s.backendOrder, people: s.people, auths: s.authByBackend, home: s.home })));
  const others = useMemo(() => {
    const out: { key: string; face: Face; words: string }[] = [];
    for (const b of order) {
      for (const p of othersHere(people[b], auths[b]?.person?.id)) {
        // one person on two backends is two people's files, but one face here when the names match
        if (out.some((o) => o.face.name === p.name)) continue;
        out.push({ key: `${b}:${p.id}`, face: faceOf(p), words: `${p.name} (${p.role})` });
      }
    }
    return out;
  }, [order, people, auths]);
  const auth = auths[home];
  const me = people[home]?.people.find((p) => p.id === auth?.person?.id);
  const several = order.some((b) => (people[b]?.people.length ?? 0) > 1);
  if (!several && others.length === 0) return null;
  // a role caps a token only where the backend enforces who calls
  const limit = auth?.mode === "enforce" ? roleLimit(auth.person?.role, auth.rights) : null;
  const onWords = others.length === 0 ? "Nobody else is on." : `${others.map((o) => o.words).join(", ")} ${others.length === 1 ? "is" : "are"} on.`;
  const meWords = me ? ` You are ${me.name} (${me.role}).` : "";
  const words = `${onWords}${meWords}${limit ? ` ${limit}` : ""}`;
  return (
    <button type="button" className={limit ? "mini people-chip limited" : "mini people-chip"} aria-label={`People: ${words}`} title={`${words} Press for the people, teams and invites (g then u)`} onClick={() => openView("people")}>
      {others.slice(0, FACES).map((o) => (
        <Avatar key={o.key} face={o.face} on size="sm" />
      ))}
      {others.length > FACES && <span className="people-more">+{others.length - FACES}</span>}
      {me && <Avatar face={faceOf(me)} size="sm" />}
      {limit && <span className="people-limit">viewing</span>}
    </button>
  );
}

/** The others who have a repo open, on its card. */
export function HereFaces({ repoId }: { repoId: string }) {
  const b = backendOf(repoId);
  const roster = useStore((s) => s.people[b]);
  const me = useStore((s) => s.authByBackend[b]?.person?.id);
  const here = useMemo(() => othersAt(roster, me, plainOf(repoId)), [roster, me, repoId]);
  if (here.length === 0) return null;
  const words = `${here.map((p) => p.name).join(", ")} ${here.length === 1 ? "has" : "have"} this repo open`;
  return (
    <span className="here-faces" role="img" aria-label={words} title={words}>
      {here.slice(0, FACES).map((p) => (
        <Avatar key={p.id} face={faceOf(p)} on size="sm" />
      ))}
      {here.length > FACES && <span className="people-more">+{here.length - FACES}</span>}
    </span>
  );
}

/** " · by Avery" after a run's or a shell's facts: the person who started
 *  it, when that was not this page's own. `id` is the run's or the shell's,
 *  which says whose roster names them. */
export function ByWho({ id, who, className = "run-by" }: { id: string; who: string | undefined; className?: string }) {
  const b = backendOf(id);
  const roster = useStore((s) => s.people[b]);
  const me = useStore((s) => s.authByBackend[b]?.person?.id);
  if (!who || who === me) return null;
  return (
    <span className={className} title="the person who started it">
      {" "}
      · by {nameOf(roster?.people, who)}
    </span>
  );
}

/** how long a sign-in that worked stays said */
const SAID_FOR = 8000;

/** What became of an invite this page traded: who it is now, or why not. A
 *  refusal stays until it is dismissed. */
export function JoinedNote() {
  const joined = useStore((s) => s.joined);
  const dismiss = useStore((s) => s.dismissJoined);
  useEffect(() => {
    if (!joined?.ok) return;
    const t = setTimeout(dismiss, SAID_FOR);
    return () => clearTimeout(t);
  }, [joined, dismiss]);
  if (!joined) return null;
  return (
    <p className={joined.ok ? "joined-note" : "joined-note failed"} role={joined.ok ? "status" : "alert"}>
      <span>{joined.words}</span>
      <button type="button" className="mini" onClick={dismiss}>
        dismiss
      </button>
    </p>
  );
}
