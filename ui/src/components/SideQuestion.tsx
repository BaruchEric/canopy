import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { resolveAgent } from "../../../src/core/route";
import { SIDE_WORD, sideQuestion, sideRefusal, withoutSideWord, withSideWord } from "../../../src/core/sidequestion";
import { isRunActive, type Repo, type Run } from "../../../src/core/types";
import { PHONE } from "../media";
import { backendOf } from "../registry";
import { AGENT_NAME, harnessOf, runWord } from "../runs";
import { modelWord, sideAsked, sideBeside, sideGoes, sideModel, sideModels } from "../side";
import { routesOf, useStore } from "../store";
import { RunPane } from "./RunSheet";
import { useLacks } from "../useLacks";

/* A side question (FR-077). A message that opens with `btw` in a run's box
 * does not go to the run: it starts a chat forked from the run's session,
 * which answers beside the run while the run works on. Here: what the box
 * shows and does for one (`useSideBox`), the column a run's console draws
 * for the side question on show (`SideColumn`), and the line a side
 * question's own console opens with (`SideLine`). */

const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);

/** The run a box may ask a side question beside. */
export interface SideFrom {
  run: Run;
  /** shows the run's console once the question is asked, for a box that
   *  sits where no column can (the agents board) */
  reveal?: () => void;
}

/** Where a box's text goes when sent. */
type SideGoes =
  /** to the run, as a message of any other kind does */
  | { to: "run" }
  /** nowhere yet: it is a side question with nothing asked, or the run
   *  takes none now */
  | { to: "held" }
  /** beside the run: `send` starts the side question */
  | { to: "side"; send: (text: string) => Promise<void> };

/** What a box shows and does for a side question. */
export type SideBox = SideGoes & {
  /** the line over the box while the text is one */
  hint: ReactNode;
  /** the button that makes the text one, for whoever does not know the word */
  button: ReactNode;
};

const NO_SIDE: SideBox = { to: "run", hint: null, button: null };

/** A question the server refused, with the text it was sent as: the line
 *  shows it until that text is edited. */
interface Refused {
  text: string;
  why: string;
}

/** A message box's side question: as soon as its text opens with `btw`, a
 *  line says where the message will go and on which model, with a way to
 *  send it to the run after all. `from` absent, the box asks none (a side
 *  question's own box, or one whose words go elsewhere). */
export function useSideBox({ from, text, setText, box }: {
  from: SideFrom | undefined;
  text: string;
  setText: (text: string) => void;
  box: RefObject<HTMLTextAreaElement | null>;
}): SideBox {
  const run = from?.run;
  const askSide = useStore((s) => s.askSide);
  // the model the repo's chats run on, on this run's harness: what a side
  // question gets unless another is picked here
  const own = useStore((s) => {
    const repo = run ? s.repos.find((r) => r.id === run.repoId) : undefined;
    return run && repo ? resolveAgent(routesOf(s, backendOf(run.repoId)), repo.path, "chat", { harness: harnessOf(run) }).settings.model : "default";
  });
  const [picked, setPicked] = useState<string | null>(null);
  // "to the run" was chosen for the text as it stands
  const [direct, setDirect] = useState(false);
  const [failed, setFailed] = useState<Refused | null>(null);
  const matches = run !== undefined && sideQuestion(text) !== null;
  // the choice lasts while the text is a side question, and no longer
  useEffect(() => {
    if (!matches) setDirect(false);
  }, [matches]);

  if (!run) return NO_SIDE;
  const refused = sideRefusal(run);
  const goes = sideGoes(text, run, direct);
  const model = picked ?? own;
  // the server's no, for as long as the box holds what it said no to
  const error = failed && failed.text === text ? failed.why : null;

  const send = async (message: string) => {
    const asked = sideQuestion(message);
    if (!asked) return;
    setFailed(null);
    try {
      await askSide(run.id, asked, picked ?? undefined);
      from.reveal?.();
    } catch (err) {
      setFailed({ text: message, why: errText(err) });
      throw err;
    }
  };
  // the word goes in front of what is typed, or comes off again
  const toggle = () => {
    setText(matches ? withoutSideWord(text) : withSideWord(text));
    setDirect(false);
    box.current?.focus();
  };

  const hint = matches ? (
    <div className="side-hint">
      {error ? (
        <span className="side-hint-err" role="alert">
          {error}
        </span>
      ) : direct ? (
        <span>This goes to the run as typed, {SIDE_WORD} and all.</span>
      ) : refused ? (
        <span>
          <b>Side question.</b> Not now: {refused}.
        </span>
      ) : (
        <>
          <span>
            <b>Side question.</b> A thread beside this run answers it. The run gets no message and works on.
          </span>
          <label className="side-model">
            <span>on</span>
            <select
              className="settings-input"
              value={model}
              title="The model that answers this side question. The repo's chats run on the one it starts on, and the run keeps its own."
              onChange={(e) => setPicked(e.target.value === own ? null : e.target.value)}
              aria-label="Model for the side question"
            >
              {sideModels(harnessOf(run), own, model).map((m) => (
                <option key={m} value={m}>
                  {modelWord(m)}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button type="button" className="mini" title={direct ? "Ask it beside the run instead: the run gets no message" : "Send it to the run as a message, as typed"} onClick={() => setDirect(!direct)}>
        {direct ? "ask it beside the run" : "send it to the run instead"}
      </button>
    </div>
  ) : null;

  const button = (
    <button
      type="button"
      className={`mini side-btn${goes === "run" ? "" : " on"}`}
      aria-pressed={goes !== "run"}
      aria-label="Side question"
      title={`Ask a side question: a thread beside this run answers it, and the run gets no message and works on. Starting a message with ${SIDE_WORD} does the same.`}
      onClick={toggle}
    >
      {SIDE_WORD}
    </button>
  );

  return goes === "side" ? { to: "side", send, hint, button } : { to: goes, hint, button };
}

/** Whether the sheet around `ref` has room for a column beside the run,
 *  following the sheet as it is resized. Before it is measured, a phone's
 *  width says no. */
function useBeside(ref: RefObject<HTMLElement | null>, shown: boolean): boolean {
  const [beside, setBeside] = useState(() => typeof matchMedia !== "function" || !matchMedia(PHONE).matches);
  useLayoutEffect(() => {
    const host = ref.current?.parentElement;
    if (!host) return;
    const measure = () => setBeside(sideBeside(host.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const seen = new ResizeObserver(measure);
    seen.observe(host);
    return () => seen.disconnect();
  }, [ref, shown]);
  return beside;
}

/** A side question's model: the select that changes it for the messages
 *  that follow, between its turns. */
function SideModel({ run }: { run: Run }) {
  const modelRun = useStore((s) => s.modelRun);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = sideModel(run);
  const live = !run.kept && isRunActive(run);
  const between = live && run.status === "idle";
  const pick = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      await modelRun(run.id, next);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <label className="side-model">
        <span>model</span>
        <select
          className="settings-input"
          value={model}
          disabled={!between || busy}
          title={between ? "The model this thread's next messages run on. The run it started from keeps its own." : live ? "It is mid-reply: pick the model once it has answered" : "The thread has ended"}
          onChange={(e) => void pick(e.target.value)}
          aria-label="This side question's model"
        >
          {sideModels(harnessOf(run), model).map((m) => (
            <option key={m} value={m}>
              {modelWord(m)}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <span className="side-hint-err" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/**
 * The side question on show beside a run: a column in the run's console
 * with a head that says what was asked and where it started from, the
 * thread's own timeline and box, and its model. It takes the sheet's right
 * half when the sheet has room, and lies over the run with a way back when
 * it has not. Closing the column leaves the chat open (its tab brings it
 * back); "end chat" ends it. Nothing shows while the run has none on show.
 */
export function SideColumn({ run, repo }: { run: Run; repo: Repo | undefined }) {
  const side = useStore((s) => {
    const id = s.sideShown[run.id];
    return id ? s.runs[id] : undefined;
  });
  const showSide = useStore((s) => s.showSide);
  const stopRun = useStore((s) => s.stopRun);
  const dismissRun = useStore((s) => s.dismissRun);
  const ref = useRef<HTMLElement>(null);
  const beside = useBeside(ref, side !== undefined);
  const [error, setError] = useState<string | null>(null);
  // a viewer reads the side question and changes nothing in it (FR-074)
  const reads = useLacks(run.repoId, "operate");
  if (!side) return null;
  const live = !side.kept && isRunActive(side);
  const between = live && side.status === "idle";
  const asked = sideAsked(side);
  const from = side.sideOf?.title ?? "";
  const act = (go: () => Promise<void>) => {
    setError(null);
    go().catch((err: unknown) => setError(errText(err)));
  };
  return (
    <aside ref={ref} className={`side-q ${beside ? "beside" : "over"}`} aria-label={`Side question: ${asked}`}>
      <header className="side-q-head">
        <div className="side-q-what">
          <div className="eyebrow">Side question · with {AGENT_NAME[harnessOf(side)]}</div>
          <h3 className="side-q-title" title={asked}>
            {asked}
          </h3>
          <div className="side-q-from" title={`Forked from this run's session as it stood when the question was asked. The run got no message.\n${from}`}>
            Started from: {from}
          </div>
        </div>
        <span className={`status st-${side.status}`}>
          <span className="dot" />
          {runWord(side)}
        </span>
        <button
          type="button"
          className="mini close"
          title="Put the side question away. Its chat stays open, and its tab brings it back."
          aria-label="Close the side question's column"
          onClick={() => showSide(run.id, null)}
        >
          {beside ? "✕" : "‹ back to the run"}
        </button>
      </header>
      <RunPane run={side} repo={repo} />
      <footer className="side-q-foot">
        {!reads && <SideModel run={side} />}
        {error && (
          <span className="side-hint-err" role="alert">
            {error}
          </span>
        )}
        <span className="spacer" />
        {reads ? null : live ? (
          <button
            type="button"
            className="mini"
            title={between ? "End this side question's chat. The run it started from is left alone." : "Stop this side question's reply and end its chat"}
            onClick={() => act(() => stopRun(side.id))}
          >
            {between ? "end chat" : "stop"}
          </button>
        ) : (
          !side.kept && (
            <button type="button" className="mini" onClick={() => act(() => dismissRun(side.id))}>
              dismiss
            </button>
          )
        )}
      </footer>
    </aside>
  );
}

/** What a side question's own console says under its tabs: the run it was
 *  asked beside, its model, and a way to see the two side by side while
 *  that run is still on the page. `solo` is a console in a window of its
 *  own, which has nowhere to show another run. */
export function SideLine({ run, solo }: { run: Run; solo: boolean }) {
  const parent = run.sideOf?.run;
  const here = useStore((s) => (parent ? s.runs[parent] !== undefined : false));
  const openSide = useStore((s) => s.openSide);
  if (!run.sideOf || !parent) return null;
  return (
    <div className="run-fork side-line">
      <span className="run-parent-text" title="A chat forked from that run's session as it stood when the question was asked. That run got no message.">
        a side question, started from: {run.sideOf.title}
      </span>
      <SideModel run={run} />
      <span className="spacer" />
      {here && !solo && (
        <button
          type="button"
          className="mini"
          title="Open the run it started from, with this thread beside it"
          onClick={() => openSide(run.id)}
        >
          show beside its run
        </button>
      )}
    </div>
  );
}
