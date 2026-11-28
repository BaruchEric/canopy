//! Agent routing as the config holds it (`src/core/route.ts`): profiles,
//! per-role picks and repo overrides, each read field by field, and the
//! shape `GET /api/agents` answers. The resolver (`resolveAgent`) is not
//! ported yet.

use regex::Regex;
use serde_json::{Map, Value, json};
use std::sync::LazyLock;

use crate::agent::{default_agent, normalize_agent, same_agent};

/// the kinds of work canopy starts an agent for, in the TS's order
pub const AGENT_ROLES: [&str; 6] = ["shell", "chat", "job", "flow", "suggest", "coordinate"];

/// the profile that is always there
pub const DEFAULT_PROFILE: &str = "default";

static PROFILE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,31}$").unwrap());
static SCOPE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9_-]{0,79}$").unwrap());

/// A name every JS object already has would read the prototype's; of
/// those, only `constructor` fits the lowercase patterns.
fn inherited(name: &str) -> bool {
    name == "constructor"
}

pub fn is_profile_name(v: &str) -> bool {
    PROFILE_RE.is_match(v) && !inherited(v)
}

pub fn is_agent_scope_name(v: &str) -> bool {
    SCOPE_RE.is_match(v) && !inherited(v)
}

/// A pick: a profile by a valid name, or settings checked field by field;
/// None for anything else.
pub fn normalize_pick(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    if let Some(p) = o.get("profile") {
        return p
            .as_str()
            .filter(|p| is_profile_name(p))
            .map(|p| json!({ "profile": p }));
    }
    Some(normalize_agent(v))
}

pub fn normalize_named_picks(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(o) = v.as_object() {
        for (name, raw) in o {
            if !is_agent_scope_name(name) {
                continue;
            }
            if let Some(p) = normalize_pick(raw) {
                out.insert(name.clone(), p);
            }
        }
    }
    out
}

/// The per-role picks, unknown roles and bad picks left out.
pub fn normalize_roles(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if v.is_object() {
        for role in AGENT_ROLES {
            if let Some(p) = v.get(role).and_then(normalize_pick) {
                out.insert(role.into(), p);
            }
        }
    }
    out
}

/// The profiles by name, bad names left out; `default` only when it
/// differs from the builtin.
pub fn normalize_profiles(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(o) = v.as_object() {
        for (name, raw) in o {
            if !is_profile_name(name) {
                continue;
            }
            let a = normalize_agent(raw);
            if name == DEFAULT_PROFILE && same_agent(&a, &default_agent()) {
                continue;
            }
            out.insert(name.clone(), a);
        }
    }
    out
}

/// A repo's entry: one saved before roles is plain settings and reads as
/// `{ all: entry }`; the new shape keeps each valid pick.
pub fn normalize_repo_agent(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(o) = v.as_object() else { return out };
    let say_off = o.get("collisionSay") == Some(&Value::Bool(false));
    if !["all", "roles", "workflows", "tasks"]
        .iter()
        .any(|k| o.contains_key(*k))
    {
        let mut legacy = o.clone();
        legacy.remove("collisionSay");
        if !legacy.is_empty() {
            out.insert("all".into(), normalize_agent(&Value::Object(legacy)));
        }
        if say_off {
            out.insert("collisionSay".into(), json!(false));
        }
        return out;
    }
    let null = Value::Null;
    let workflows = normalize_named_picks(o.get("workflows").unwrap_or(&null));
    if !workflows.is_empty() {
        out.insert("workflows".into(), Value::Object(workflows));
    }
    let tasks = normalize_named_picks(o.get("tasks").unwrap_or(&null));
    if !tasks.is_empty() {
        out.insert("tasks".into(), Value::Object(tasks));
    }
    if let Some(all) = o.get("all").and_then(normalize_pick) {
        out.insert("all".into(), all);
    }
    let roles = normalize_roles(o.get("roles").unwrap_or(&null));
    if !roles.is_empty() {
        out.insert("roles".into(), Value::Object(roles));
    }
    if say_off {
        out.insert("collisionSay".into(), json!(false));
    }
    out
}

pub fn is_empty_repo_agent(r: &Map<String, Value>) -> bool {
    let full = |k: &str| {
        r.get(k)
            .and_then(Value::as_object)
            .is_some_and(|m| !m.is_empty())
    };
    r.get("collisionSay") != Some(&Value::Bool(false))
        && !r.contains_key("all")
        && !["roles", "workflows", "tasks"].iter().any(|k| full(k))
}

/// The repo overrides, empty ones left out.
pub fn normalize_repo_agents(v: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    if let Some(o) = v.as_object() {
        for (path, raw) in o {
            let r = normalize_repo_agent(raw);
            if !is_empty_repo_agent(&r) {
                out.insert(path.clone(), Value::Object(r));
            }
        }
    }
    out
}

/// Every profile with `default` among them, the builtin first when unset.
pub fn with_default_profile(profiles: &Map<String, Value>) -> Map<String, Value> {
    if profiles.contains_key(DEFAULT_PROFILE) {
        return profiles.clone();
    }
    let mut out = Map::new();
    out.insert(DEFAULT_PROFILE.into(), default_agent());
    for (k, v) in profiles {
        out.insert(k.clone(), v.clone());
    }
    out
}

/// The routing a config holds, read from its raw JSON.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Routing {
    pub profiles: Map<String, Value>,
    pub roles: Map<String, Value>,
    pub repos: Map<String, Value>,
    pub workflows: Map<String, Value>,
    pub tasks: Map<String, Value>,
}

impl Routing {
    pub fn from_config(raw: &Value) -> Routing {
        let null = Value::Null;
        let at = |k: &str| raw.get(k).unwrap_or(&null);
        Routing {
            profiles: normalize_profiles(at("profiles")),
            roles: normalize_roles(at("agentRoles")),
            repos: normalize_repo_agents(at("agents")),
            workflows: normalize_named_picks(at("agentWorkflows")),
            tasks: normalize_named_picks(at("agentTasks")),
        }
    }

    /// What `GET /api/agents` answers (`agentRoutes`).
    pub fn routes(&self) -> Value {
        let mut out = Map::new();
        out.insert(
            "profiles".into(),
            Value::Object(with_default_profile(&self.profiles)),
        );
        out.insert("roles".into(), Value::Object(self.roles.clone()));
        out.insert("repos".into(), Value::Object(self.repos.clone()));
        if !self.workflows.is_empty() {
            out.insert("workflows".into(), Value::Object(self.workflows.clone()));
        }
        if !self.tasks.is_empty() {
            out.insert("tasks".into(), Value::Object(self.tasks.clone()));
        }
        Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repo_entry_from_before_roles_reads_as_its_whole_repo_pick() {
        let r = normalize_repo_agent(&json!({ "model": "sonnet", "collisionSay": false }));
        assert_eq!(r["all"]["model"], "sonnet");
        assert_eq!(r["collisionSay"], false);
        assert!(normalize_repo_agent(&json!({ "collisionSay": true })).is_empty());
    }

    #[test]
    fn the_new_shape_keeps_valid_picks_and_drops_the_rest() {
        let r = normalize_repo_agent(&json!({
            "all": { "profile": "Bad" },
            "roles": { "job": { "harness": "codex" }, "nope": { "profile": "fast" } },
            "workflows": { "ship": { "profile": "fast" }, "Bad Name": { "profile": "fast" } }
        }));
        assert!(r.get("all").is_none());
        assert_eq!(r["roles"].as_object().unwrap().len(), 1);
        assert_eq!(r["workflows"], json!({ "ship": { "profile": "fast" } }));
    }

    #[test]
    fn profiles_drop_bad_names_and_a_default_that_matches_the_builtin() {
        let p = normalize_profiles(&json!({
            "default": {}, "fast": { "model": "haiku" }, "Bad": {}, "constructor": {}
        }));
        assert_eq!(p.keys().collect::<Vec<_>>(), ["fast"]);
        let with = with_default_profile(&p);
        assert_eq!(with.keys().collect::<Vec<_>>(), ["default", "fast"]);
    }

    #[test]
    fn routes_carry_workflows_and_tasks_only_when_set() {
        let r = Routing::from_config(&json!({
            "agentRoles": { "chat": { "profile": "fast" }, "nope": {} },
            "agentTasks": { "lint": { "profile": "fast" } }
        }))
        .routes();
        assert_eq!(r["roles"], json!({ "chat": { "profile": "fast" } }));
        assert!(r.get("workflows").is_none());
        assert_eq!(r["tasks"], json!({ "lint": { "profile": "fast" } }));
        assert_eq!(r["profiles"]["default"], default_agent());
    }
}
