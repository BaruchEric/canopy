import { useEffect, useState } from "react";
import { screenLayoutOf, useStore } from "../store";
import { matchProfile, recommendLayout, type MatchHow } from "../../../src/core/screenlayouts";
import type { ScreenProfile } from "../../../src/core/types";
import { detectModel, deviceHere, draftOf, fieldsOf, physicalNow, screenHere, type Draft, type Tri } from "../screenprofiles";

const HOW: Record<MatchHow, string> = {
  device: "by its device",
  exact: "by its exact size",
  nearest: "the nearest size",
};

type Note = { ok: boolean; text: string };

const failed = (e: unknown): Note => ({ ok: false, text: e instanceof Error ? e.message : String(e) });

/**
 * Screen layouts in Settings: the presets and the user's own profiles,
 * kept on the home backend, the one that fits this screen lit. Each can be
 * applied here by hand; a screen this browser has never arranged takes its
 * match on its own when the window moves onto it (store.ts, onScreen).
 * Presets are edited and reset, the user's own created, copied and
 * deleted, the delete asked inside the row.
 */
export function ScreenLayoutsRow() {
  const profiles = useStore((s) => s.screenProfiles);
  const named = useStore((s) => s.settings.device);
  const [model, setModel] = useState("");
  const [detecting, setDetecting] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [allPresets, setAllPresets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  useEffect(() => {
    // what the browser already lets us read, never a permission prompt
    let live = true;
    void detectModel(false).then((m) => {
      if (live && m) setModel(m);
    });
    void useStore.getState().loadScreenProfiles();
    return () => {
      live = false;
    };
  }, []);

  const at = physicalNow();
  const here = screenHere(deviceHere(named), model);
  const match = here ? matchProfile(profiles, here) : null;
  const own = profiles.filter((p) => !p.builtin);
  const presets = profiles.filter((p) => p.builtin);
  const shown = allPresets ? presets : presets.filter((p) => p.id === match?.profile.id || p.edited);

  const run = async (what: () => Promise<Note | null>) => {
    setBusy(true);
    try {
      setNote(await what());
    } catch (e) {
      setNote(failed(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = (p: ScreenProfile) => {
    useStore.getState().applyScreenLayout(p.layout);
    setNote({ ok: true, text: `applied ${p.name} to this window` });
  };

  const detect = async () => {
    setDetecting(true);
    const m = await detectModel(true);
    setDetecting(false);
    setModel(m);
    setNote(m ? { ok: true, text: `this screen says it is ${m}` } : { ok: false, text: "this browser names no model for this screen" });
  };

  const fresh = (): Draft => {
    const w = at?.width ?? 1920;
    const h = at?.height ?? 1080;
    const dpr = at?.dpr ?? 1;
    return draftOf({
      name: model || `${w}×${h}`,
      device: deviceHere(named),
      ...(model ? { model } : {}),
      width: w,
      height: h,
      dpr,
      layout: recommendLayout(Math.round(w / dpr), Math.round(h / dpr)),
    });
  };

  const save = (id: string | null, draft: Draft) =>
    run(async () => {
      const checked = fieldsOf(draft);
      if ("error" in checked) return { ok: false, text: checked.error };
      const p = await useStore.getState().saveScreenProfile({ id, fields: checked.profile });
      setEditing(null);
      return { ok: true, text: `kept ${p.name}` };
    });

  const row = (p: ScreenProfile) => {
    const on = match?.profile.id === p.id;
    const asking = confirming === p.id;
    const size = `${p.width}×${p.height}`;
    // what the name does not already say
    const about = [p.name.includes(size) ? "" : size, p.device !== p.name ? p.device : "", p.model ?? "", p.edited ? "edited" : ""].filter(Boolean);
    return (
      <li key={p.id} className={on ? "layout-row on" : "layout-row"}>
        <div className="layout-what">
          <span className="layout-name">{p.name}</span>
          {about.length > 0 && <span className="layout-size">{about.join(" · ")}</span>}
          {on && match && <span className="layout-match">fits this screen, {HOW[match.how]}</span>}
        </div>
        {asking ? (
          <div className="layout-acts">
            <span className="layout-ask">{p.builtin ? "put it back as it ships?" : "delete it?"}</span>
            <button
              type="button"
              className="mini confirm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await useStore.getState().dropScreenProfile(p.id);
                  setConfirming(null);
                  return { ok: true, text: p.builtin ? `reset ${p.name}` : `deleted ${p.name}` };
                })
              }
            >
              {p.builtin ? "reset" : "delete"}
            </button>
            <button type="button" className="mini" onClick={() => setConfirming(null)}>
              keep
            </button>
          </div>
        ) : (
          <div className="layout-acts">
            <button type="button" className="mini" title="Lay this profile over this window now" onClick={() => apply(p)}>
              apply
            </button>
            <button type="button" className="mini" onClick={() => setEditing({ id: p.id, draft: draftOf(p) })}>
              edit
            </button>
            <button
              type="button"
              className="mini"
              disabled={busy}
              title="A profile of your own to start from this one"
              onClick={() =>
                void run(async () => {
                  const made = await useStore.getState().saveScreenProfile({ from: p.id });
                  setEditing({ id: made.id, draft: draftOf(made) });
                  return { ok: true, text: `made ${made.name}` };
                })
              }
            >
              copy
            </button>
            {(!p.builtin || p.edited) && (
              <button type="button" className="mini" onClick={() => setConfirming(p.id)}>
                {p.builtin ? "reset" : "delete"}
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <section className="settings-row">
      <h3 className="panel-label">screen layouts</h3>
      <p className="settings-hint">
        {at ? `This screen is ${at.width}×${at.height} physical px at ${at.dpr}x` : "No screen to read"}
        {model ? `, and says it is ${model}` : ""}.{" "}
        {match ? `${match.profile.name} fits it, ${HOW[match.how]}.` : profiles.length === 0 ? "This backend keeps no layouts." : ""}
      </p>
      <div className="key-row">
        {match && (
          <button type="button" className="mini" onClick={() => apply(match.profile)}>
            apply {match.profile.name}
          </button>
        )}
        <button type="button" className="mini" disabled={detecting} title="Ask the browser for this screen's model name" onClick={() => void detect()}>
          {detecting ? "asking…" : "detect"}
        </button>
        <button type="button" className="mini" disabled={profiles.length === 0} onClick={() => setEditing({ id: null, draft: fresh() })}>
          new profile
        </button>
      </div>
      {editing && (
        <ProfileForm
          draft={editing.draft}
          isNew={editing.id === null}
          busy={busy}
          onChange={(draft) => setEditing({ ...editing, draft })}
          onSave={() => void save(editing.id, editing.draft)}
          onCancel={() => setEditing(null)}
        />
      )}
      {note && <p className={note.ok ? "settings-hint" : "settings-hint error"}>{note.text}</p>}
      {(own.length > 0 || shown.length > 0) && (
        <ul className="layout-list" aria-label="Screen layout profiles">
          {own.map(row)}
          {shown.map(row)}
        </ul>
      )}
      {presets.length > 0 && (
        <button type="button" className="mini" onClick={() => setAllPresets(!allPresets)}>
          {allPresets ? "only the one that fits" : `every preset (${presets.length})`}
        </button>
      )}
      <p className="settings-hint">
        Kept on the home backend for every browser. A screen this browser has never arranged takes the one that fits as the window moves onto
        it; any other waits for apply. A layout never opens or closes a panel.
      </p>
    </section>
  );
}

const TRI: { value: Tri; label: string }[] = [
  { value: "", label: "leave" },
  { value: "on", label: "on" },
  { value: "off", label: "off" },
];

/** the create and edit form: the screen it is for, then each layout value,
 *  an empty one left alone when it applies */
function ProfileForm({
  draft,
  isNew,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  isNew: boolean;
  busy: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v });
  const text = (k: keyof Draft, label: string, hint = "") => (
    <label className="layout-field">
      <span>{label}</span>
      <input className="settings-input" type="text" value={draft[k]} placeholder={hint} onChange={(e) => set(k, e.target.value)} />
    </label>
  );
  const tri = (k: "carousel" | "sidebarOpen" | "feedOpen", label: string) => (
    <label className="layout-field">
      <span>{label}</span>
      <select className="settings-input" value={draft[k]} onChange={(e) => set(k, TRI.find((t) => t.value === e.target.value)?.value ?? "")}>
        {TRI.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
  const fill = (layout: ReturnType<typeof screenLayoutOf>) => {
    const d = draftOf({ layout });
    onChange({ ...draft, ...Object.fromEntries(LAYOUT_FIELDS.map((k) => [k, d[k]])) });
  };
  const recommended = () => {
    const w = Number(draft.width);
    const h = Number(draft.height);
    const dpr = Number(draft.dpr) > 0 ? Number(draft.dpr) : 1;
    if (w > 0 && h > 0) fill(recommendLayout(Math.round(w / dpr), Math.round(h / dpr)));
  };
  return (
    <form
      className="layout-form"
      aria-label={isNew ? "New screen layout" : "Edit screen layout"}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="layout-grid">
        {text("name", "name")}
        {text("device", "device", "MacBook Pro 16")}
        {text("model", "model", "what detect reads")}
        {text("width", "width, px")}
        {text("height", "height, px")}
        {text("dpr", "pixel ratio", "1")}
      </div>
      <div className="key-row">
        <button type="button" className="mini" onClick={() => fill(screenLayoutOf(useStore.getState()))} title="This window's arrangement, widths, zoom and font">
          take this window's layout
        </button>
        <button type="button" className="mini" onClick={recommended} title="What a screen this size is recommended">
          recommended for this size
        </button>
      </div>
      <div className="layout-grid">
        <label className="layout-field">
          <span>dock</span>
          <select className="settings-input" value={draft.arrange} onChange={(e) => set("arrange", e.target.value === "columns" || e.target.value === "tabs" ? e.target.value : "")}>
            <option value="">leave</option>
            <option value="columns">side by side</option>
            <option value="tabs">tabs</option>
          </select>
        </label>
        {tri("carousel", "carousel")}
        {tri("sidebarOpen", "repo tree")}
        {text("sidebarWidth", "tree width")}
        {text("columnWidth", "column width")}
        {text("panelZoom", "panel zoom")}
        {text("termFont", "shell font")}
        <label className="layout-field">
          <span>panel shows</span>
          <select
            className="settings-input"
            value={draft.level}
            onChange={(e) => set("level", e.target.value === "intermediate" || e.target.value === "advanced" ? e.target.value : "")}
          >
            <option value="">leave</option>
            <option value="intermediate">intermediate</option>
            <option value="advanced">advanced</option>
          </select>
        </label>
        {tri("feedOpen", "event feed")}
        {text("sectionsHidden", "hidden sections", "peers, launch")}
      </div>
      <div className="key-row">
        <button type="submit" className="mini" disabled={busy}>
          {isNew ? "create" : "save"}
        </button>
        <button type="button" className="mini" onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

const LAYOUT_FIELDS = [
  "arrange",
  "carousel",
  "sidebarOpen",
  "sidebarWidth",
  "columnWidth",
  "panelZoom",
  "termFont",
  "level",
  "sectionsHidden",
  "feedOpen",
] as const satisfies readonly (keyof Draft)[];
