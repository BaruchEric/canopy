import { useEffect, useState } from "react";
import { describeAgent, normalizeAgent, withHarness } from "../../../src/core/agent";
import { HARNESS, takesModel } from "../../../src/core/harness";
import { hasProfile, isProfilePick, roleRefusal, roleTakes } from "../../../src/core/route";
import { HARNESSES, type AgentPick, type AgentRole, type AgentRoutes, type AgentSettings, type Harness } from "../../../src/core/types";
import { harnessWord, pickOf, pickValue, profileNames, ROLE_LABEL, ROLE_TITLE, slotHarnesses, type EffectiveRow } from "../agents";
import { Seg } from "./Seg";

/**
 * One set of agent settings, edited in place: the harness first, since it
 * decides what the rest may be, then the model (claude's closed list as a
 * row of choices, codex's open one as a box with the known names offered),
 * the effort the harness takes, permissions and extra flags. Every choice
 * saves at once; the two text boxes save on blur or Enter, since a
 * half-typed model or flag is not worth sending.
 */
export function AgentSettingsForm({
  value,
  onChange,
  has,
  allowed = HARNESSES,
  machine,
}: {
  value: AgentSettings;
  onChange: (next: AgentSettings) => void;
  /** the harnesses the backend has installed */
  has: readonly Harness[];
  /** the harnesses where these settings are used can run */
  allowed?: readonly Harness[];
  /** the backend's name, for "codex is not installed on mini" */
  machine: string;
}) {
  const h = HARNESS[value.harness];
  const [model, setModel] = useState(value.model);
  const [extra, setExtra] = useState(value.extra);
  const [modelError, setModelError] = useState(false);
  useEffect(() => setModel(value.model), [value.model]);
  useEffect(() => setExtra(value.extra), [value.extra]);
  const set = <K extends keyof AgentSettings>(key: K, v: AgentSettings[K]) => onChange(normalizeAgent({ ...value, [key]: v }));
  const saveModel = () => {
    const m = model.trim() || "default";
    if (m === value.model) return;
    if (!takesModel(value.harness, m)) {
      setModelError(true);
      return;
    }
    setModelError(false);
    set("model", m);
  };
  const saveExtra = () => {
    if (extra.trim() !== value.extra) set("extra", extra.trim());
  };
  const missing = !has.includes(value.harness);
  const listId = `models-${value.harness}`;
  return (
    <div className="agent-settings">
      <section className="settings-row">
        <h3 className="panel-label">harness</h3>
        <Seg
          label="Harness"
          value={value.harness}
          options={HARNESSES.map((x) => ({
            value: x,
            label: harnessWord(x),
            disabled: x !== value.harness && (!has.includes(x) || !allowed.includes(x)),
            title: !has.includes(x)
              ? `${HARNESS[x].label} is not installed on ${machine}`
              : !allowed.includes(x)
                ? `${HARNESS[x].label} cannot run this yet`
                : `Start ${HARNESS[x].label === "claude" ? "Claude Code" : "Codex"}`,
          }))}
          onChange={(x) => onChange(withHarness(value, x))}
        />
        {missing && <p className="settings-hint warn">{h.label} is not installed on {machine}; a start on it is refused there.</p>}
      </section>
      <section className="settings-row">
        <h3 className="panel-label">model</h3>
        {h.openModels ? (
          <>
            <input
              type="text"
              className="agent-extra"
              list={listId}
              value={model}
              placeholder="default"
              aria-label={`Model for ${h.label}`}
              aria-invalid={modelError}
              onChange={(e) => {
                setModel(e.target.value);
                setModelError(false);
              }}
              onBlur={saveModel}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveModel();
              }}
            />
            <datalist id={listId}>
              {h.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className={modelError ? "settings-hint error" : "settings-hint"}>
              {modelError ? "A model name is one plain word, not a flag or claude's own alias." : "Any model codex knows; default leaves it to codex's config."}
            </p>
          </>
        ) : (
          <Seg
            label="Model"
            value={value.model}
            options={h.models.map((m) => ({ value: m, label: m, ...(m === "default" ? { title: `Whatever your ${h.label} picks` } : {}) }))}
            onChange={(m) => set("model", m)}
          />
        )}
      </section>
      <section className="settings-row">
        <h3 className="panel-label">effort</h3>
        <Seg
          label="Effort"
          value={value.effort}
          options={h.efforts.map((e) => ({ value: e, label: e, ...(e === "default" ? { title: `Whatever your ${h.label} picks` } : {}) }))}
          onChange={(e) => set("effort", e)}
        />
      </section>
      <section className="settings-row">
        <h3 className="panel-label">permissions</h3>
        <Seg
          label="Permissions"
          value={value.yolo ? "yolo" : "ask"}
          options={[
            { value: "ask", label: "ask", title: h.askTitle },
            { value: "yolo", label: "yolo", title: h.yoloTitle },
          ]}
          onChange={(v) => set("yolo", v === "yolo")}
        />
        {value.yolo && <p className="settings-hint warn">Every command runs without asking.</p>}
      </section>
      <section className="settings-row">
        <h3 className="panel-label">extra flags</h3>
        <input
          type="text"
          className="agent-extra"
          placeholder={value.harness === "codex" ? "--search --add-dir ../shared" : "--add-dir ../shared --name work"}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onBlur={saveExtra}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveExtra();
          }}
          aria-label={`Extra flags for the ${h.label} command line`}
        />
        <p className="settings-hint">Appended to the {h.label} command line as typed; quotes hold a word together.</p>
      </section>
    </div>
  );
}

/**
 * A route's pick, in a select: inherit (what the next layer says), a
 * profile, or settings of its own, which opens the form below the select.
 * A profile of a harness the slot cannot run stays choosable, since what a
 * profile holds can change, and says it will be passed over.
 */
export function PickEditor({
  slot,
  pick,
  routes,
  has,
  machine,
  inherit,
  seed,
  onChange,
  compact = false,
  profiles = true,
}: {
  slot: AgentRole | "all";
  pick: AgentPick | undefined;
  routes: AgentRoutes;
  has: readonly Harness[];
  machine: string;
  /** what "inherit" means here, in words */
  inherit: string;
  /** where settings of its own start from: what the slot resolves to now */
  seed: AgentSettings;
  onChange: (pick: AgentPick | null) => void;
  /** no inline form; settings of their own are shown as one line */
  compact?: boolean;
  /** offer the profiles; off for a backend older than routing, which keeps
   *  plain settings only */
  profiles?: boolean;
}) {
  const value = pickValue(pick);
  const gone = pick && isProfilePick(pick) && !hasProfile(routes.profiles, pick.profile) ? pick.profile : null;
  const allowed = slotHarnesses(slot);
  return (
    <div className="pick-editor">
      <select
        className="settings-input pick-select"
        value={value}
        aria-label={slot === "all" ? "Whole repo" : ROLE_LABEL[slot]}
        onChange={(e) => onChange(pickOf(e.target.value, pick, seed))}
      >
        <option value="">{inherit}</option>
        {(profiles ? profileNames(routes) : []).map((name) => {
          const s = routes.profiles[name]!;
          const passed = slot !== "all" && !roleTakes(slot, s.harness);
          return (
            <option key={name} value={`profile:${name}`}>
              {HARNESS[s.harness].glyph} {name} · {describeAgent(s, false)}
              {passed ? " (passed over here)" : ""}
            </option>
          );
        })}
        {gone && <option value={`profile:${gone}`}>{gone} (gone: falls through)</option>}
        <option value="custom">settings of its own…</option>
      </select>
      {pick && !isProfilePick(pick) && !compact && (
        <AgentSettingsForm value={pick} onChange={(next) => onChange(next)} has={has} allowed={allowed} machine={machine} />
      )}
      {pick && !isProfilePick(pick) && compact && (
        <span className="pick-own">
          {HARNESS[pick.harness].glyph} {describeAgent(pick, false)}
        </span>
      )}
      {slot !== "all" && pick && !isProfilePick(pick) && !roleTakes(slot, pick.harness) && (
        <p className="settings-hint warn">{roleRefusal(slot, pick.harness)}</p>
      )}
    </div>
  );
}

/** Each role's resolved harness, settings and where they came from, with
 *  what was passed over and why. */
export function EffectiveTable({ rows }: { rows: readonly EffectiveRow[] }) {
  return (
    <table className="effective-table">
      <thead>
        <tr>
          <th scope="col">role</th>
          <th scope="col">harness</th>
          <th scope="col">settings</th>
          <th scope="col">from</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.role} className={r.flags.length ? "flagged" : undefined}>
            <th scope="row" title={ROLE_TITLE[r.role]}>
              {ROLE_LABEL[r.role]}
            </th>
            <td className={`h-${r.settings.harness}`}>{r.harness}</td>
            <td>
              {r.line}
              {r.flags.map((f) => (
                <span key={f} className="effective-flag">
                  {f}
                </span>
              ))}
            </td>
            <td className="effective-from">{r.from}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
