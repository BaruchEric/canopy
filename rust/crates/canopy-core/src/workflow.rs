//! A workflow file (`src/core/workflow.ts`, in part): frontmatter for the
//! identity, one `##` heading per step with a short key block under it and
//! the prompt after. Ported: `frontmatter` and `parseWorkflow` with every
//! rule it holds a file to, the tool sets a step's `tools:` line names
//! (`TOOL_SETS` in actions.ts) and a profile's name (`isProfileName` in
//! route.ts). Not yet: `readOnlyTools`, `readOnlyStep`, `chained` and
//! `unattendedRefusal`, which only the server reads.
//!
//! An entry is the JSON the TypeScript makes, key for key (`WorkflowEntry`
//! in types.ts), so the CLI reads one parsed here and one a backend sent
//! the same way.

use crate::pathx::{js_trim, js_ws};
use serde_json::{Map, Value, json};

/// `WORKFLOW_WHENS` in types.ts.
pub const WORKFLOW_WHENS: &[&str] = &["dirty", "unpushed", "dirty-or-unpushed", "any"];
/// `GATE_KINDS` in types.ts.
pub const GATE_KINDS: &[&str] = &["continue", "ask", "verdict", "judge"];
/// `STEP_WHENS` in types.ts.
pub const STEP_WHENS: &[&str] = &[
    "always",
    "verdict done",
    "verdict partial",
    "verdict blocked",
    "judge meets",
    "judge partly",
    "judge misses",
    "check pass",
    "check fail",
    "changed",
    "unchanged",
    "skipped",
];
/// `STEP_MODES` in types.ts.
pub const STEP_MODES: &[&str] = &["auto", "manual"];

const GIT_READ: &[&str] = &[
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git branch:*)",
    "Bash(git remote:*)",
    "Bash(git rev-parse:*)",
    "Bash(git fetch:*)",
];
const GIT_COMMIT: &[&str] = &[
    "Bash(git add:*)",
    "Bash(git commit:*)",
    "Bash(git restore --staged:*)",
];
const GIT_PUSH: &[&str] = &["Bash(git push:*)"];
const BUN: &[&str] = &[
    "Bash(bun run:*)",
    "Bash(bun test:*)",
    "Bash(bun install)",
    "Bash(bun x:*)",
    "Bash(bunx:*)",
];
const READ: &[&str] = &["Read", "Glob", "Grep"];

/// `TOOL_SETS` in actions.ts: the names a step's `tools:` line may use in
/// place of rules.
pub fn tool_set(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "git-read" => Some(GIT_READ),
        "git-commit" => Some(GIT_COMMIT),
        "git-push" => Some(GIT_PUSH),
        "bun" => Some(BUN),
        "read" => Some(READ),
        _ => None,
    }
}

/// `isProfileName()` in route.ts: `/^[a-z0-9][a-z0-9_-]{0,31}$/`, and not
/// a name every object has (`constructor` is the one the pattern lets by).
pub fn is_profile_name(v: &str) -> bool {
    let mut chars = v.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let rest_ok =
        chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    first_ok && rest_ok && v.len() <= 32 && v != "constructor"
}

const DEFAULT_TURNS: f64 = 30.0;
const MAX_RETRIES: f64 = 10.0;
const MAX_CHECK_MINUTES: f64 = 120.0;

/// `Number(s)` (`js::number_of`).
pub fn to_number(s: &str) -> f64 {
    crate::js::number_of(s)
}

/// `Number.isInteger(n)`.
fn is_integer(n: f64) -> bool {
    n.is_finite() && n.trunc() == n
}

use crate::js::num;

/// A file a workflow cannot be read from, and why (`Bad`).
type Bad = String;

/// The keys of a key block, in order, a later one replacing an earlier.
#[derive(Debug, Default)]
pub struct Keys(Vec<(String, String)>);

impl Keys {
    pub fn get(&self, k: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    }

    fn set(&mut self, k: &str, v: &str) {
        match self.0.iter_mut().find(|(key, _)| key == k) {
            Some(slot) => slot.1 = v.to_string(),
            None => self.0.push((k.to_string(), v.to_string())),
        }
    }

    /// `keys.get(k) || null`: an empty value counts as none.
    fn filled(&self, k: &str) -> Option<&str> {
        self.get(k).filter(|v| !v.is_empty())
    }
}

/// JavaScript's line terminators, which `.` does not match.
fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `/^([a-z][a-z-]*):[ \t]*(.*)$/`: a key line's key and its value.
fn key_line(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let key = &line[..colon];
    let mut chars = key.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_lowercase())
        || !chars.all(|c| c.is_ascii_lowercase() || c == '-')
    {
        return None;
    }
    let value = line[colon + 1..].trim_start_matches([' ', '\t']);
    if value.chars().any(line_end) {
        return None;
    }
    Some((key, value))
}

/// `key: value` lines into keys; a line that is not one ends the block.
fn key_block<'a>(lines: &'a [&'a str]) -> (Keys, &'a [&'a str]) {
    let mut keys = Keys::default();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if js_trim(line).is_empty() {
            break;
        }
        let Some((k, v)) = key_line(line) else {
            break;
        };
        keys.set(k, js_trim(v));
        i += 1;
    }
    (keys, &lines[i..])
}

/// `text.split(/\r?\n/)`.
fn split_lines(text: &str) -> Vec<&str> {
    text.split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .collect()
}

/// `frontmatter()`: the --- block's keys and the body after it.
pub fn frontmatter(text: &str) -> Result<(Keys, String), String> {
    let lines = split_lines(text);
    if lines.first().map(|l| js_trim(l)) != Some("---") {
        return Err("no frontmatter: the file must start with a --- block".into());
    }
    let end = lines
        .iter()
        .enumerate()
        .position(|(i, l)| i > 0 && js_trim(l) == "---")
        .ok_or("frontmatter never closes: no second --- line")?;
    let (keys, rest) = key_block(&lines[1..end]);
    if let Some(stray) = rest.iter().find(|l| !js_trim(l).is_empty()) {
        return Err(format!("frontmatter line is not key: value: {stray}"));
    }
    Ok((keys, lines[end + 1..].join("\n")))
}

fn one_of(v: Option<&str>, allowed: &[&str], what: &str, fallback: &str) -> Result<String, Bad> {
    match v {
        None | Some("") => Ok(fallback.into()),
        Some(v) if allowed.contains(&v) => Ok(v.into()),
        Some(v) => Err(format!(
            "{what} must be one of {}, not {v}",
            allowed.join(", ")
        )),
    }
}

fn boolean(v: Option<&str>, what: &str) -> Result<bool, Bad> {
    match v {
        None | Some("") | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(v) => Err(format!("{what} must be true or false, not {v}")),
    }
}

fn tools(v: Option<&str>) -> Vec<String> {
    let line = v.filter(|v| !v.is_empty()).unwrap_or("git-read");
    let mut out: Vec<String> = Vec::new();
    for w in line.split(',').map(js_trim).filter(|w| !w.is_empty()) {
        let expanded: Vec<&str> = tool_set(w).map_or_else(|| vec![w], |set| set.to_vec());
        for rule in expanded {
            if !out.iter().any(|r| r == rule) {
                out.push(rule.to_string());
            }
        }
    }
    out
}

/// An `agent:` line's profile name, or None when there is none.
fn agent_key(v: Option<&str>, what: &str) -> Result<Option<String>, Bad> {
    match v {
        None | Some("") => Ok(None),
        Some(v) if is_profile_name(v) => Ok(Some(v.into())),
        Some(v) => Err(format!(
            "{what} must name a profile (lowercase letters, digits, - and _), not {v}"
        )),
    }
}

fn retries_key(v: Option<&str>, name: &str) -> Result<f64, Bad> {
    let Some(v) = v.filter(|v| !v.is_empty()) else {
        return Ok(0.0);
    };
    let n = to_number(v);
    if !is_integer(n) || n < 0.0 || n > MAX_RETRIES {
        return Err(format!(
            "step {name}: retries must be a whole number from 0 to {MAX_RETRIES}, not {v}"
        ));
    }
    Ok(n)
}

fn check_minutes_key(v: Option<&str>, name: &str, check: Option<&str>) -> Result<Option<f64>, Bad> {
    let Some(v) = v.filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let n = to_number(v);
    if !v.bytes().all(|b| b.is_ascii_digit()) || n < 1.0 || n > MAX_CHECK_MINUTES {
        return Err(format!(
            "step {name}: check-minutes must be a whole number from 1 to {MAX_CHECK_MINUTES}, not {v}"
        ));
    }
    if check.is_none() {
        return Err(format!("step {name}: check-minutes needs a check"));
    }
    Ok(Some(n))
}

/// `v.split(/\s+/).filter(Boolean)`.
fn words(v: &str) -> Vec<&str> {
    v.split(js_ws).filter(|w| !w.is_empty()).collect()
}

fn evidence_key(v: Option<&str>, name: &str) -> Result<Vec<String>, Bad> {
    let Some(v) = v.filter(|v| !v.is_empty()) else {
        return Ok(Vec::new());
    };
    let paths = words(v);
    for p in &paths {
        if p.starts_with('/') || p.split('/').any(|seg| seg == "..") {
            return Err(format!(
                "step {name}: evidence must be paths inside the repo, not {p}"
            ));
        }
    }
    Ok(paths.into_iter().map(String::from).collect())
}

/// `/^(\d+)\s+runs?\s*,\s*(\d+(?:\.\d+)?)\s*h$/`: the runs and the hours.
fn budget_parts(v: &str) -> Option<(&str, &str)> {
    let runs_end = v.find(|c: char| !c.is_ascii_digit())?;
    let runs = &v[..runs_end];
    let rest = &v[runs_end..];
    let after_ws = rest.trim_start_matches(js_ws);
    if runs.is_empty() || after_ws.len() == rest.len() {
        return None;
    }
    let after_word = after_ws.strip_prefix("run")?;
    let after_word = after_word.strip_prefix('s').unwrap_or(after_word);
    let after_comma = after_word.trim_start_matches(js_ws).strip_prefix(',')?;
    let hours_start = after_comma.trim_start_matches(js_ws);
    let whole_end = hours_start
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(hours_start.len());
    if whole_end == 0 {
        return None;
    }
    let mut hours_end = whole_end;
    if let Some(frac) = hours_start[whole_end..].strip_prefix('.') {
        let n = frac
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(frac.len());
        if n > 0 {
            hours_end = whole_end + 1 + n;
        }
    }
    let hours = &hours_start[..hours_end];
    let tail = hours_start[hours_end..].trim_start_matches(js_ws);
    if tail != "h" {
        return None;
    }
    Some((runs, hours))
}

fn budget_key(v: Option<&str>) -> Result<Value, Bad> {
    let Some(v) = v.filter(|v| !v.is_empty()) else {
        return Ok(Value::Null);
    };
    let bad = || format!("budget must read like \"30 runs, 6h\", not {v}");
    let (runs, hours) = budget_parts(v).ok_or_else(bad)?;
    let (runs, hours) = (to_number(runs), to_number(hours));
    if runs.is_nan() || runs <= 0.0 || hours.is_nan() || hours <= 0.0 {
        return Err(bad());
    }
    Ok(json!({ "runs": num(runs), "hours": num(hours) }))
}

/// A step as its block reads, before `after` and `when` are checked
/// against the others (`ParsedStep`).
struct ParsedStep {
    name: String,
    gate: String,
    check: Option<String>,
    back: String,
    /// the step's fields in the TypeScript's order, `after` and `when` to come
    fields: Map<String, Value>,
    after: Option<String>,
    when: Option<String>,
}

fn comma_words(value: &str) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for part in value.split(',') {
        let word = js_trim(part);
        if !word.is_empty() && !words.iter().any(|w| w == word) {
            words.push(word.to_string());
        }
    }
    words
}

fn step(name: &str, lines: &[&str], agent: Option<&str>) -> Result<ParsedStep, Bad> {
    let (keys, rest) = key_block(lines);
    let turns_raw = keys.get("turns");
    let turns = match turns_raw {
        None | Some("") => DEFAULT_TURNS,
        Some(t) => to_number(t),
    };
    if !is_integer(turns) || turns <= 0.0 {
        return Err(format!(
            "step {name}: turns must be a positive whole number, not {}",
            turns_raw.unwrap_or("undefined")
        ));
    }
    let gate = one_of(
        keys.get("gate"),
        GATE_KINDS,
        &format!("step {name}: gate"),
        "continue",
    )?;
    let check = keys.filled("check").map(String::from);
    let body = js_trim(&rest.join("\n")).to_string();
    if body.is_empty() && check.is_none() {
        return Err(format!("step {name} has neither a prompt nor a check"));
    }
    let profile = agent_key(keys.get("agent"), &format!("step {name}: agent"))?
        .or_else(|| agent.map(String::from));
    let evidence = evidence_key(keys.get("evidence"), name)?;
    if !evidence.is_empty() && gate != "judge" {
        return Err(format!("step {name}: evidence is only read by gate: judge"));
    }
    let mode = one_of(
        keys.get("mode"),
        STEP_MODES,
        &format!("step {name}: mode"),
        "auto",
    )?;
    let check_minutes = check_minutes_key(keys.get("check-minutes"), name, check.as_deref())?;
    let tools = tools(keys.get("tools"));
    let retries = retries_key(keys.get("retries"), name)?;
    let back = keys.filled("back").unwrap_or(name).to_string();
    let mut fields = Map::new();
    fields.insert("name".into(), json!(name));
    fields.insert("tools".into(), json!(tools));
    fields.insert("turns".into(), num(turns));
    fields.insert("check".into(), json!(check));
    fields.insert("gate".into(), json!(gate));
    fields.insert("body".into(), json!(body));
    fields.insert("retries".into(), num(retries));
    fields.insert("back".into(), json!(back));
    fields.insert("evidence".into(), json!(evidence));
    fields.insert("mode".into(), json!(mode));
    if let Some(m) = check_minutes {
        fields.insert("checkMinutes".into(), num(m));
    }
    if let Some(p) = profile {
        fields.insert("agent".into(), json!(p));
    }
    Ok(ParsedStep {
        name: name.into(),
        gate,
        check,
        back,
        fields,
        after: keys.get("after").map(String::from),
        when: keys.get("when").map(String::from),
    })
}

/// The one `after` value that is not a heading: the step waits for nothing
/// and starts with the first step. It is the only way a later heading
/// becomes a second root, since a missing `after` is the step above.
pub const AFTER_NONE: &str = "none";

fn position_of(steps: &[ParsedStep], name: &str) -> Option<usize> {
    steps.iter().position(|s| s.name == name)
}

fn after_steps(index: usize, steps: &[ParsedStep]) -> Result<Vec<String>, Bad> {
    let parsed = &steps[index];
    let names = match &parsed.after {
        Some(raw) if !js_trim(raw).is_empty() => comma_words(raw),
        _ => Vec::new(),
    };
    if names.iter().any(|n| n == AFTER_NONE) {
        if names.len() > 1 {
            return Err(format!(
                "step {}: after none waits for nothing, so it names no other step",
                parsed.name
            ));
        }
        if position_of(steps, AFTER_NONE).is_some() {
            return Err(format!(
                "step {}: after none is reserved, so rename the step called none",
                parsed.name
            ));
        }
        return Ok(Vec::new());
    }
    if names.is_empty() {
        return Ok(match index.checked_sub(1) {
            Some(i) => vec![steps[i].name.clone()],
            None => Vec::new(),
        });
    }
    for name in &names {
        let Some(position) = position_of(steps, name) else {
            return Err(format!(
                "step {}: after names no step called {name}",
                parsed.name
            ));
        };
        if position == index {
            return Err(format!("step {}: after names itself", parsed.name));
        }
        if position > index {
            return Err(format!(
                "step {}: after names a later step, {name}",
                parsed.name
            ));
        }
    }
    Ok(names)
}

fn has_prerequisite(
    after: &[String],
    steps: &[ParsedStep],
    matches: impl Fn(&ParsedStep) -> bool,
) -> bool {
    after
        .iter()
        .any(|name| position_of(steps, name).is_some_and(|p| matches(&steps[p])))
}

/// a step whose gate is `want`
fn gate_is(want: &'static str) -> impl Fn(&ParsedStep) -> bool {
    move |s| s.gate == want
}

fn when_steps(index: usize, after: &[String], steps: &[ParsedStep]) -> Result<Vec<String>, Bad> {
    let parsed = &steps[index];
    let words = parsed.when.as_deref().map(comma_words).unwrap_or_default();
    let explicit = !words.is_empty();
    let conditions = if explicit {
        words
    } else {
        vec!["always".to_string()]
    };
    for word in &conditions {
        if !STEP_WHENS.contains(&word.as_str()) {
            return Err(format!(
                "step {}: when must be one of {}, not {word}",
                parsed.name,
                STEP_WHENS.join(", ")
            ));
        }
    }
    if explicit && after.is_empty() {
        return Err(format!(
            "step {}: when needs a step before it to wait on",
            parsed.name
        ));
    }
    for condition in &conditions {
        let missing = if condition.starts_with("verdict ") {
            (!has_prerequisite(after, steps, gate_is("verdict"))).then_some("gate: verdict")
        } else if condition.starts_with("judge ") {
            (!has_prerequisite(after, steps, gate_is("judge"))).then_some("gate: judge")
        } else if condition.starts_with("check ") {
            (!has_prerequisite(after, steps, |s| s.check.is_some())).then_some("a check")
        } else {
            None
        };
        if let Some(what) = missing {
            return Err(format!(
                "step {}: when {condition} needs a step before it with {what}",
                parsed.name
            ));
        }
    }
    Ok(conditions)
}

/// `/^##\s+(.+?)\s*$/`: a heading's name, with the regex's way of reading
/// a heading of nothing but whitespace.
fn heading(line: &str) -> Option<String> {
    let rest = line.strip_prefix("##")?;
    if !rest.chars().next().is_some_and(js_ws) {
        return None;
    }
    let core = js_trim(rest);
    if !core.is_empty() {
        return if core.chars().any(line_end) {
            None
        } else {
            Some(core.to_string())
        };
    }
    // all whitespace: the name is the last character `\s+` can give back
    let chars: Vec<char> = rest.chars().collect();
    (1..chars.len())
        .rev()
        .find(|&j| !line_end(chars[j]))
        .map(|j| chars[j].to_string())
}

fn steps(body: &str, agent: Option<&str>) -> Result<Vec<Value>, Bad> {
    let mut out: Vec<ParsedStep> = Vec::new();
    let mut name: Option<String> = None;
    let mut buf: Vec<&str> = Vec::new();
    let flush =
        |name: &Option<String>, buf: &[&str], out: &mut Vec<ParsedStep>| -> Result<(), Bad> {
            let Some(name) = name else {
                return Ok(());
            };
            if out.iter().any(|s| &s.name == name) {
                return Err(format!("step {name} appears twice"));
            }
            out.push(step(name, buf, agent)?);
            Ok(())
        };
    for line in body.split('\n') {
        if let Some(h) = heading(line) {
            flush(&name, &buf, &mut out)?;
            name = Some(h);
            buf = Vec::new();
        } else if name.is_some() {
            buf.push(line);
        }
    }
    flush(&name, &buf, &mut out)?;
    if out.is_empty() {
        return Err("no steps: a workflow needs at least one ## heading".into());
    }
    for (i, s) in out.iter().enumerate() {
        let Some(to) = position_of(&out, &s.back) else {
            return Err(format!(
                "step {}: back names no step called {}",
                s.name, s.back
            ));
        };
        // back may be the step itself, a check-only step's too: its retry runs
        // the check again, since a check can fail for a reason outside the work
        if to > i {
            return Err(format!(
                "step {}: back must name this step or an earlier one, not {}",
                s.name, s.back
            ));
        }
    }
    let mut steps = Vec::new();
    for i in 0..out.len() {
        let after = after_steps(i, &out)?;
        let when = when_steps(i, &after, &out)?;
        let mut fields = out[i].fields.clone();
        fields.insert("after".into(), json!(after));
        fields.insert("when".into(), json!(when));
        steps.push(Value::Object(fields));
    }
    Ok(steps)
}

/// `/^[a-z0-9-]+$/`
fn good_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn workflow(text: &str, meta: &WorkflowMeta) -> Result<Value, Bad> {
    let (keys, body) = frontmatter(text)?;
    let name = keys.filled("name").unwrap_or(&meta.name).to_string();
    if !good_name(&name) {
        return Err(format!("name must match [a-z0-9-]+, not {name}"));
    }
    let blurb = keys
        .filled("blurb")
        .ok_or("blurb is required: one paragraph for the pre-flight")?;
    let label = keys.filled("label").unwrap_or(&name).to_string();
    let verb = keys.filled("verb").unwrap_or(&label).to_string();
    let when = one_of(keys.get("when"), WORKFLOW_WHENS, "when", "any")?;
    let listed = match keys.get("listed") {
        None | Some("") => true,
        raw => boolean(raw, "listed")?,
    };
    let expects_change = boolean(keys.get("expects-change"), "expects-change")?;
    let note = keys
        .filled("note")
        .unwrap_or("anything the agent should know (optional)");
    let note_required = boolean(keys.get("note-required"), "note-required")?;
    let agent = agent_key(keys.get("agent"), "agent")?;
    let steps = steps(&body, agent.as_deref())?;
    let budget = budget_key(keys.get("budget"))?;
    let mut w = Map::new();
    w.insert("name".into(), json!(name));
    w.insert("label".into(), json!(label));
    w.insert("verb".into(), json!(verb));
    w.insert("blurb".into(), json!(blurb));
    w.insert("when".into(), json!(when));
    w.insert("expectsChange".into(), json!(expects_change));
    w.insert("notePlaceholder".into(), json!(note));
    w.insert("noteRequired".into(), json!(note_required));
    if !listed {
        w.insert("listed".into(), json!(false));
    }
    w.insert("steps".into(), json!(steps));
    w.insert("budget".into(), budget);
    w.insert("source".into(), json!(meta.source));
    w.insert("file".into(), json!(meta.file));
    Ok(Value::Object(w))
}

/// Where a workflow file came from: its name by the file, `bundled`,
/// `user` or `repo`, and its path.
#[derive(Debug, Clone)]
pub struct WorkflowMeta {
    pub name: String,
    pub source: String,
    pub file: String,
}

/// `parseWorkflow()`: `{ok: true, workflow}`, or `{ok: false, name,
/// source, file, error}` with what is wrong with the file.
pub fn parse_workflow(text: &str, meta: &WorkflowMeta) -> Value {
    match workflow(text, meta) {
        Ok(workflow) => json!({ "ok": true, "workflow": workflow }),
        Err(error) => json!({
            "ok": false,
            "name": meta.name,
            "source": meta.source,
            "file": meta.file,
            "error": error,
        }),
    }
}

#[cfg(test)]
mod tests;
