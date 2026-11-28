//! `canopy loadouts` (FR-065, `src/cli/loadouts.ts`): the named loadouts
//! kit.json offers a run, the skills always on, the defaults, each
//! provider's state on the backend, and the lines kit.json got wrong;
//! `resolve` says what a start in a repo takes, `adopt` and `restore` move
//! a provider's hand file aside for kit.json's and back.

use crate::api::Caller;
use crate::ask::{Ask, Target, backend_targets, did_not_answer, form_query, has, shift, take};
use crate::out::Out;
use canopy_core::js::{field, join, list_at, str_at, truthy_at};
use canopy_core::pathx::{js_len, pad_end};
use serde_json::{Value, json};

/// `LOADOUTS_USAGE`.
pub const LOADOUTS_USAGE: &str = "usage: canopy loadouts [--json] [--backend URL | --on NAME]\n       canopy loadouts resolve <repo> [--action ACTION] [--json] [--backend URL | --on NAME]\n       canopy loadouts adopt|restore <provider> [--backend URL | --on NAME]";

/// `${key} ${value}` pairs of an object, in its order.
fn entries(o: Option<&Value>) -> Vec<(&String, &Value)> {
    o.and_then(Value::as_object)
        .map(|m| m.iter().collect())
        .unwrap_or_default()
}

/// `defaultLines()`: everywhere, each machine, each repo.
pub fn default_lines(info: &Value) -> Vec<String> {
    let Some(d) = info.get("defaults").filter(|d| truthy_at_v(d)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // `!== null`: a missing one prints as undefined there too
    if d.get("loadout") != Some(&Value::Null) {
        out.push(format!("default: {} everywhere", field(d, "loadout")));
    }
    for (m, name) in entries(d.get("machines")) {
        let here = if str_at(info, "machine") == Some(m.as_str()) {
            " (this backend)"
        } else {
            ""
        };
        out.push(format!(
            "default: {} on machine {m}{here}",
            canopy_core::js::template(Some(name))
        ));
    }
    for (r, name) in entries(d.get("repos")) {
        out.push(format!(
            "default: {} in {r}",
            canopy_core::js::template(Some(name))
        ));
    }
    out
}

fn truthy_at_v(v: &Value) -> bool {
    canopy_core::js::truthy(Some(v))
}

/// The fields of a line, those that are "" left out, two spaces apart.
fn columns(fields: Vec<String>) -> String {
    fields
        .into_iter()
        .filter(|f| !f.is_empty())
        .collect::<Vec<_>>()
        .join("  ")
}

/// `providerLines()`: one line per provider kit.json declares.
pub fn provider_lines(info: &Value) -> Vec<String> {
    let ps = list_at(info, "providers");
    let id_width = ps
        .iter()
        .map(|p| js_len(&field(p, "id")))
        .max()
        .unwrap_or(0);
    ps.iter()
        .map(|p| {
            let machines = match p.get("machines") {
                Some(Value::Null) => "every machine".to_string(),
                _ => format!("on {}", join(list_at(p, "machines"), ", ")),
            };
            columns(vec![
                format!("provider {}", pad_end(&field(p, "id"), id_width)),
                field(p, "harness"),
                format!(
                    "{}{}",
                    field(p, "state"),
                    if truthy_at(p, "adopted") {
                        " (adopted)"
                    } else {
                        ""
                    }
                ),
                machines,
                if truthy_at(p, "central") {
                    String::new()
                } else {
                    "own file".into()
                },
                str_at(p, "why").unwrap_or("").to_string(),
                field(p, "note"),
            ])
        })
        .collect()
}

/// `resolveLines()`: what a start in a repo takes when it names no
/// loadout, in words.
pub fn resolve_lines(repo: &str, d: &Value) -> Vec<String> {
    let key = if truthy_at(d, "key") {
        format!(" {}", field(d, "key"))
    } else {
        String::new()
    };
    let from = truthy_at(d, "from");
    let head = if truthy_at(d, "name") {
        let at = if from {
            format!(" (from {}{key})", field(d, "from"))
        } else {
            String::new()
        };
        format!("{repo}: {}{at}", field(d, "name"))
    } else {
        let says = if from {
            format!(", {}{key} says none", field(d, "from"))
        } else {
            String::new()
        };
        format!("{repo}: no loadout{says}")
    };
    let mut out = vec![head];
    for s in list_at(d, "skipped") {
        out.push(format!(
            "  passed over: {}",
            canopy_core::js::template(Some(s))
        ));
    }
    out
}

/// `loadoutLines()`: a line per loadout, then the base, the defaults, the
/// providers and the errors.
pub fn loadout_lines(info: &Value) -> Vec<String> {
    let loadouts = list_at(info, "loadouts");
    let agents: Vec<String> = loadouts
        .iter()
        .map(|l| {
            let on = if truthy_at(l, "provider") {
                format!(" on {}", field(l, "provider"))
            } else {
                String::new()
            };
            format!(
                "{} {} {}{on}",
                field(l, "harness"),
                field(l, "model"),
                field(l, "effort")
            )
        })
        .collect();
    let name_width = loadouts
        .iter()
        .map(|l| js_len(&field(l, "name")))
        .max()
        .unwrap_or(0);
    let agent_width = agents.iter().map(|a| js_len(a)).max().unwrap_or(0);
    let mut out: Vec<String> = loadouts
        .iter()
        .zip(&agents)
        .map(|(l, agent)| {
            let mut servers = list_at(l, "mcp").to_vec();
            if truthy_at(l, "canopyTools") {
                servers.push(json!("canopy tools"));
            }
            let skills = list_at(l, "skills").len();
            columns(vec![
                pad_end(&field(l, "name"), name_width),
                pad_end(agent, agent_width),
                format!("{skills} {}", if skills == 1 { "skill" } else { "skills" }),
                join(&servers, ", "),
                field(l, "note"),
            ])
        })
        .collect();
    let base = list_at(info, "base");
    if !base.is_empty() {
        out.push(format!("always on: {}", join(base, ", ")));
    }
    out.extend(default_lines(info));
    out.extend(provider_lines(info));
    for e in list_at(info, "errors") {
        out.push(format!("error: {}", canopy_core::js::template(Some(e))));
    }
    out
}

/// `JSON.stringify(v, null, 2)`.
fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `loadoutsCommand()`.
pub(crate) async fn loadouts_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let backend_flag = args.iter().any(|a| a == "--backend");
    let given = take(&mut args, "--backend");
    let on_flag = args.iter().any(|a| a == "--on");
    let on = take(&mut args, "--on");
    if backend_flag && given.is_none() {
        return Err("--backend needs a value".into());
    }
    if on_flag && on.is_none() {
        return Err("--on needs a value".into());
    }
    if backend_flag && on_flag {
        return Err("use either --backend URL or --on NAME".into());
    }
    let as_json = has(&mut args, "--json");
    let action_flag = args.iter().any(|a| a == "--action");
    let action = take(&mut args, "--action");
    if action_flag && action.is_none() {
        return Err("--action needs a value".into());
    }
    let sub = match args.first().map(String::as_str) {
        Some("resolve" | "adopt" | "restore") => shift(&mut args),
        _ => None,
    };
    let arg = if sub.is_some() {
        shift(&mut args)
    } else {
        None
    };
    let arg_missing = sub.is_some() && arg.as_deref().is_none_or(str::is_empty);
    if !args.is_empty() || arg_missing || (action.is_some() && sub.as_deref() != Some("resolve")) {
        return Err(LOADOUTS_USAGE.into());
    }
    let home = caller.api_base(given.as_deref());
    let named = match &on {
        None => None,
        Some(name) => backend_targets(ask, &home, given.is_some(), Some(name))
            .await?
            .into_iter()
            .next(),
    };
    let target = named.unwrap_or_else(|| Target::home(&home));
    let failed = |e| did_not_answer(&target.name, &e);
    match (sub.as_deref(), arg.as_deref()) {
        (Some("resolve"), Some(repo)) => {
            let mut q = vec![("id", repo)];
            if let Some(a) = action.as_deref().filter(|a| !a.is_empty()) {
                q.push(("action", a));
            }
            let path = format!("/api/loadouts/resolve?{}", form_query(&q));
            let d = ask.ask(&target, "GET", &path, None).await.map_err(failed)?;
            if as_json {
                out.line(pretty(&d));
            } else {
                out.lines(resolve_lines(repo, &d));
            }
            Ok(())
        }
        (Some(verb @ ("adopt" | "restore")), Some(id)) => {
            let path = format!("/api/kit/providers/{verb}");
            let info = ask
                .ask(&target, "POST", &path, Some(&json!({ "id": id })))
                .await
                .map_err(failed)?;
            let p = list_at(&info, "providers")
                .iter()
                .find(|x| str_at(x, "id") == Some(id));
            let state = p.map_or_else(|| "gone".to_string(), |p| field(p, "state"));
            let why = p
                .filter(|p| truthy_at(p, "why"))
                .map(|p| format!("  {}", field(p, "why")))
                .unwrap_or_default();
            out.line(format!("provider {id}: {state}{why}"));
            Ok(())
        }
        _ => {
            let info = ask
                .ask(&target, "GET", "/api/loadouts", None)
                .await
                .map_err(failed)?;
            if as_json {
                out.line(pretty(&info));
                return Ok(());
            }
            if list_at(&info, "loadouts").is_empty()
                && list_at(&info, "errors").is_empty()
                && list_at(&info, "providers").is_empty()
            {
                out.line("no loadouts in kit.json");
                return Ok(());
            }
            out.lines(loadout_lines(&info));
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_line_per_loadout_then_the_errors() {
        let info = json!({"base": ["verify-build"], "loadouts": [
            {"name": "homelab-ops", "note": "the mini's stacks", "harness": "claude", "model": "sonnet", "effort": "medium", "skills": ["homelab:tailchan"], "mcp": ["executor"], "canopyTools": false},
            {"name": "docs", "note": "", "harness": "claude", "model": "haiku", "effort": "low", "skills": [], "mcp": [], "canopyTools": true},
        ], "errors": ["loadouts.x.model: claude does not take gpt-5"], "servers": []});
        assert_eq!(
            loadout_lines(&info),
            [
                "homelab-ops  claude sonnet medium  1 skill  executor  the mini's stacks",
                "docs         claude haiku low      0 skills  canopy tools",
                "always on: verify-build",
                "error: loadouts.x.model: claude does not take gpt-5",
            ]
        );
        let bare = json!({"base": [], "loadouts": [{"name": "a", "note": "n", "harness": "codex", "model": "gpt-5", "effort": "high", "skills": ["x", "y"], "mcp": [], "canopyTools": false}], "errors": [], "servers": []});
        assert_eq!(loadout_lines(&bare), ["a  codex gpt-5 high  2 skills  n"]);
        let both = json!({"base": [], "loadouts": [{"name": "a", "note": "", "harness": "claude", "model": "m", "effort": "low", "skills": [], "mcp": ["s1", "s2"], "canopyTools": true}], "errors": [], "servers": []});
        assert_eq!(
            loadout_lines(&both),
            ["a  claude m low  0 skills  s1, s2, canopy tools"]
        );
    }

    #[test]
    fn a_provider_rides_beside_its_agent_and_the_defaults_follow() {
        let info = json!({"base": [], "loadouts": [
            {"name": "off", "note": "", "harness": "claude", "model": "default", "effort": "default", "skills": [], "mcp": [], "canopyTools": false, "provider": "local"},
        ], "errors": [], "servers": [], "machine": "mac",
        "defaults": {"loadout": "quick", "machines": {"mac": "off"}, "repos": {"dev-tools/*": "none"}},
        "providers": [{"id": "local", "note": "llama", "harness": "claude", "machines": ["mac"], "central": false, "envNames": [], "keys": [], "state": "hand", "why": "this machine keeps its own file"}]});
        assert_eq!(
            loadout_lines(&info),
            [
                "off  claude default default on local  0 skills",
                "default: quick everywhere",
                "default: off on machine mac (this backend)",
                "default: none in dev-tools/*",
                "provider local  claude  hand  on mac  own file  this machine keeps its own file  llama",
            ]
        );
        let none = json!({"base": [], "loadouts": [], "errors": [], "servers": []});
        assert!(default_lines(&none).is_empty());
        assert!(provider_lines(&none).is_empty());
        let adopted = json!({"providers": [{"id": "gw", "note": "", "harness": "claude", "machines": null, "central": true, "envNames": ["T"], "keys": ["env"], "state": "ok", "adopted": true}]});
        assert_eq!(
            provider_lines(&adopted),
            ["provider gw  claude  ok (adopted)  every machine"]
        );
    }

    #[test]
    fn resolve_says_the_loadout_and_where_it_came_from() {
        assert_eq!(
            resolve_lines(
                "app",
                &json!({"name": "feature", "from": "repo", "key": "dev-tools/*"})
            ),
            ["app: feature (from repo dev-tools/*)"]
        );
        assert_eq!(
            resolve_lines(
                "app",
                &json!({"name": null, "from": "machine", "key": "mini"})
            ),
            ["app: no loadout, machine mini says none"]
        );
        assert_eq!(
            resolve_lines(
                "app",
                &json!({"name": null, "from": null, "skipped": ["repo app: cx runs codex"]})
            ),
            ["app: no loadout", "  passed over: repo app: cx runs codex"]
        );
    }

    #[test]
    fn the_resolve_query_is_form_encoded() {
        assert_eq!(
            form_query(&[("id", "web/my app"), ("action", "fix!")]),
            "id=web%2Fmy+app&action=fix%21"
        );
    }
}
