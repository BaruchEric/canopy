//! `canopy plugins` (`src/cli/plugins.ts`, FR-064): the kit's agent plugins
//! from a terminal, the same reads and ops the plugins view runs. Also
//! `isPluginAgent` and `opText` from src/core/plugins.ts, the two parts of
//! that file this verb prints with.

use crate::api::Caller;
use crate::ask::{
    Ask, Target, did_not_answer, form_query, listed_targets, shift, skipped_line, take,
};
use crate::capacity::js_number_of;
use crate::out::Out;
use canopy_core::js::{field, list_at, str_at, template, truthy, truthy_at};
use canopy_core::pathx::js_trim_end;
use serde_json::{Map, Value, json};

/// `PLUGINS_USAGE`.
pub const PLUGINS_USAGE: &str = "usage: canopy plugins [list] [--machine M] [--agent claude|codex]
       canopy plugins install|uninstall|update|enable|disable <name@marketplace> --machine M [--agent claude|codex] [--accept SHA256]
       canopy plugins search [words] --machine M [--agent claude|codex] [--limit N]
       canopy plugins marketplace add <source> | remove <name> | update <name> --machine M [--agent claude|codex]
       canopy plugins commit [--machine M] [--dry-run]
       --backend URL asks that backend alone";

/// `isPluginAgent()`.
fn is_plugin_agent(v: &str) -> bool {
    v == "claude" || v == "codex"
}

/// `opText()`: an op on `what` in words; an op it does not know is its
/// own value, as the TypeScript's exhaustive switch returns it.
fn op_text(op: Option<&Value>, what: &str) -> String {
    match op.and_then(Value::as_str) {
        Some("install") => format!("install {what}"),
        Some("uninstall") => format!("remove {what}"),
        Some("update") => format!("update {what}"),
        Some("enable") => format!("turn on {what}"),
        Some("disable") => format!("turn off {what}"),
        Some("market-add") => format!("add the marketplace {what}"),
        Some("market-remove") => format!("remove the marketplace {what}"),
        Some("market-update") => format!("update the marketplace {what}"),
        _ => template(op),
    }
}

use canopy_core::js::keys as js_keys;

/// `pluginLines()`: a machine's plugins as lines, the machine, then a line
/// per plugin installed or turned on in settings.json.
pub fn plugin_lines(m: &Value, agent: Option<&str>) -> Vec<String> {
    if truthy_at(m, "away") {
        return vec![format!(
            "{}  away: {}",
            field(m, "machine"),
            field(m, "away")
        )];
    }
    let shared = truthy_at(m, "shared");
    let how = if !shared {
        "own settings.json"
    } else if truthy_at(m, "commits") {
        "commits the shared settings.json"
    } else {
        "follows the shared settings.json"
    };
    let unpushed = if shared && truthy_at(m, "unpushed") {
        let one = m.get("unpushed").and_then(Value::as_f64) == Some(1.0);
        format!(
            ", {} dotclaude {} not pushed",
            field(m, "unpushed"),
            if one { "commit" } else { "commits" }
        )
    } else {
        String::new()
    };
    let dirty = if shared && truthy_at(m, "settingsDirty") {
        ", settings.json changed and not committed"
    } else {
        ""
    };
    let mut out = vec![format!("{}  {how}{dirty}{unpushed}", field(m, "machine"))];
    for a in list_at(m, "agents") {
        let name = field(a, "agent");
        if agent.is_some_and(|want| a.get("agent").and_then(Value::as_str) != Some(want)) {
            continue;
        }
        if truthy_at(a, "error") {
            out.push(format!("  {name}  {}", field(a, "error")));
        }
        let plugins = list_at(a, "plugins");
        for p in plugins {
            let servers: Vec<&str> = js_keys(p.get("servers"))
                .into_iter()
                .map(String::as_str)
                .collect();
            let errors = list_at(p, "errors");
            let fails = match errors.first() {
                Some(first) => format!(
                    "  fails: {}",
                    if first.is_null() {
                        String::new()
                    } else {
                        template(Some(first))
                    }
                ),
                None => String::new(),
            };
            let version = if truthy_at(p, "version") {
                format!(" {}", field(p, "version"))
            } else {
                String::new()
            };
            let servers = if servers.is_empty() {
                String::new()
            } else {
                format!("  servers: {}", servers.join(", "))
            };
            out.push(format!(
                "  {name}  {}  {}{version}{servers}{fails}",
                field(p, "id"),
                if truthy_at(p, "enabled") { "on" } else { "off" }
            ));
        }
        let declared = a.get("declared");
        for id in js_keys(declared) {
            let on = truthy(declared.and_then(|d| d.get(id.as_str())));
            let installed = plugins
                .iter()
                .any(|p| p.get("id").and_then(Value::as_str) == Some(id.as_str()));
            if on && !installed {
                out.push(format!(
                    "  {name}  {id}  wanted: settings.json turns it on, not installed here"
                ));
            }
        }
        let markets = list_at(a, "markets");
        if !markets.is_empty() {
            let names: Vec<String> = markets.iter().map(|x| field(x, "name")).collect();
            out.push(format!("  {name}  marketplaces: {}", names.join(", ")));
        }
    }
    out
}

use canopy_core::js::number_string as js_string;

/// `catalogLines()`: a search's entries, then the count.
pub fn catalog_lines(c: &Value) -> Vec<String> {
    let entries = list_at(c, "entries");
    let mut out: Vec<String> = entries
        .iter()
        .map(|e| {
            let installed = if truthy_at(e, "installed") {
                "  (installed)"
            } else {
                ""
            };
            let installs = match e.get("installs") {
                Some(Value::Null) => String::new(),
                v => format!("  {} installs", template(v)),
            };
            let description = if truthy_at(e, "description") {
                format!("  {}", field(e, "description"))
            } else {
                String::new()
            };
            format!("{}{installed}{installs}{description}", field(e, "id"))
        })
        .collect();
    let more = c
        .get("total")
        .and_then(Value::as_f64)
        .is_some_and(|t| t > entries.len() as f64);
    out.push(format!(
        "{} on {} for {}{}",
        field(c, "total"),
        field(c, "machine"),
        field(c, "agent"),
        if more {
            format!(", {} shown", entries.len())
        } else {
            String::new()
        }
    ));
    out
}

/// `commitPreviewLines()`: what a commit holds by name, then the message.
pub fn commit_preview_lines(p: &Value) -> Vec<String> {
    let branch = if truthy_at(p, "branch") {
        field(p, "branch")
    } else {
        "its branch".into()
    };
    let mut out = vec![format!(
        "{}: settings.json on {branch}",
        field(p, "machine")
    )];
    let lines = list_at(p, "lines");
    if lines.is_empty() {
        out.push("  changes only the file's layout".into());
    } else {
        out.extend(lines.iter().map(|l| format!("  {}", template(Some(l)))));
    }
    out.push(String::new());
    for l in field(p, "message").split('\n') {
        out.push(js_trim_end(&format!("  | {l}")).to_string());
    }
    out
}

/// `commitResultLine()`.
pub fn commit_result_line(r: &Value) -> String {
    if str_at(r, "outcome") == Some("failed") {
        format!(
            "{}: nothing committed: {}",
            field(r, "machine"),
            field(r, "message")
        )
    } else {
        format!("{}: {}", field(r, "machine"), field(r, "message"))
    }
}

/// `opLines()`: what an op came to, or the command it waits on.
pub fn op_lines(r: &Value, what: &str) -> Vec<String> {
    let text = op_text(r.get("op"), what);
    if str_at(r, "outcome") == Some("confirm") {
        return vec![
            format!(
                "{}: {text} waits: the marketplace declares a command to run",
                field(r, "machine")
            ),
            format!("  {}", field(r, "command")),
            format!(
                "read it, then run the same command again with --accept {}",
                field(r, "sha256")
            ),
        ];
    }
    let done = if str_at(r, "outcome") == Some("ok") {
        "done"
    } else {
        "failed"
    };
    vec![format!(
        "{}: {text} {done}: {}",
        field(r, "machine"),
        field(r, "message")
    )]
}

/// `PLUGIN_OPS`.
fn plugin_op(sub: &str) -> Option<&'static str> {
    match sub {
        "install" => Some("install"),
        "uninstall" | "remove" => Some("uninstall"),
        "update" => Some("update"),
        "enable" => Some("enable"),
        "disable" => Some("disable"),
        _ => None,
    }
}

/// `MARKET_OPS`.
fn market_op(verb: &str) -> Option<&'static str> {
    match verb {
        "add" => Some("market-add"),
        "remove" | "rm" => Some("market-remove"),
        "update" => Some("market-update"),
        _ => None,
    }
}

/// One plugin machine and the backend that reads it.
struct Seen {
    t: Target,
    m: Value,
}

/// `read()`: every backend's plugin machines; one that cannot answer is
/// named and skipped.
async fn read(targets: &[Target], ask: &impl Ask, out: &mut Out) -> Vec<Seen> {
    let mut seen: Vec<Seen> = Vec::new();
    for t in targets {
        match ask.ask(t, "GET", "/api/kit", None).await {
            Ok(info) => {
                // a backend just started has no scan yet ("not scanned yet"); say so
                // rather than let a missing machine read as one kit.json does not mark
                if !truthy_at(&info, "ok") && truthy_at(&info, "error") {
                    out.line(format!("{}'s kit: {}", t.name, field(&info, "error")));
                }
                for m in list_at(&info, "plugins") {
                    if !seen.iter().any(|x| x.m.get("machine") == m.get("machine")) {
                        seen.push(Seen {
                            t: t.clone(),
                            m: m.clone(),
                        });
                    }
                }
            }
            Err(e) => out.line(skipped_line(&t.name, &e)),
        }
    }
    seen
}

/// `pluginsCommand()`.
pub(crate) async fn plugins_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let machine = take(&mut args, "--machine");
    let agent_given = take(&mut args, "--agent");
    let accept = take(&mut args, "--accept");
    let limit = take(&mut args, "--limit").map_or(30.0, |v| js_number_of(&v));
    let limit = if limit == 0.0 || limit.is_nan() {
        30.0
    } else {
        limit
    };
    let sub = shift(&mut args).unwrap_or_else(|| "list".into());
    if agent_given.as_deref().is_some_and(|a| !is_plugin_agent(a)) {
        return Err(format!("--agent is claude or codex\n{PLUGINS_USAGE}"));
    }
    // a list shows every agent unless one is named; an op is claude's unless codex is
    let only = agent_given.as_deref().filter(|a| is_plugin_agent(a));
    let agent = only.unwrap_or("claude");
    let home = caller.api_base(given.as_deref());
    let targets = listed_targets(ask, &home, given.is_some()).await;
    // `!machine`: an empty --machine counts as none
    let named = machine.as_deref().filter(|m| !m.is_empty());

    if sub == "list" || sub == "status" {
        let ms = read(&targets, ask, out).await;
        if ms.is_empty() {
            return Err("no backend reads plugins: kit.json's plugins names the agents".into());
        }
        for Seen { m, .. } in &ms {
            if named.is_none_or(|want| m.get("machine").and_then(Value::as_str) == Some(want)) {
                out.lines(plugin_lines(m, only));
            }
        }
        return Ok(());
    }
    if sub == "commit" {
        // the machine kit.json marks as committing dotclaude, unless one is named
        let ms = read(&targets, ask, out).await;
        let hit = match named {
            Some(want) => ms
                .iter()
                .find(|x| x.m.get("machine").and_then(Value::as_str) == Some(want)),
            None => ms.iter().find(|x| truthy_at(&x.m, "commits")),
        };
        let Some(hit) = hit else {
            return Err(match named {
                Some(want) => format!("no backend reads plugins on {want}"),
                None => {
                    "no machine is marked to commit dotclaude: kit.json machines.<name>.commits"
                        .into()
                }
            });
        };
        let name = field(&hit.m, "machine");
        let path = format!(
            "/api/kit/plugins/commit?{}",
            form_query(&[("machine", &name)])
        );
        let p = ask
            .ask(&hit.t, "GET", &path, None)
            .await
            .map_err(|e| did_not_answer(&hit.t.name, &e))?;
        out.lines(commit_preview_lines(&p));
        if args.iter().any(|a| a == "--dry-run") {
            return Ok(());
        }
        let mut body = Map::new();
        body.insert(
            "machine".into(),
            hit.m.get("machine").cloned().unwrap_or(Value::Null),
        );
        if let Some(sha) = p.get("sha") {
            body.insert("sha".into(), sha.clone());
        }
        let r = ask
            .ask(
                &hit.t,
                "POST",
                "/api/kit/plugins/commit",
                Some(&Value::Object(body)),
            )
            .await
            .map_err(|e| did_not_answer(&hit.t.name, &e))?;
        out.line(commit_result_line(&r));
        if str_at(&r, "outcome") != Some("pushed") {
            out.failed = true;
        }
        return Ok(());
    }

    // the backend that reads plugins on --machine
    let owner = async |out: &mut Out| -> Result<Target, String> {
        let Some(want) = named else {
            return Err(format!("--machine is required\n{PLUGINS_USAGE}"));
        };
        read(&targets, ask, out)
            .await
            .into_iter()
            .find(|x| x.m.get("machine").and_then(Value::as_str) == Some(want))
            .map(|x| x.t)
            .ok_or_else(|| format!("no backend reads plugins on {want}"))
    };

    if sub == "search" {
        let t = owner(out).await?;
        let q = args.join(" ");
        let limit = js_string(limit);
        let path = format!(
            "/api/kit/plugins/catalog?{}",
            form_query(&[
                ("machine", machine.as_deref().unwrap_or("")),
                ("agent", agent),
                ("q", &q),
                ("limit", &limit),
            ])
        );
        let c = ask
            .ask(&t, "GET", &path, None)
            .await
            .map_err(|e| did_not_answer(&t.name, &e))?;
        out.lines(catalog_lines(&c));
        return Ok(());
    }
    let mut body = Map::new();
    body.insert(
        "machine".into(),
        machine.as_deref().map_or(Value::Null, |m| json!(m)),
    );
    body.insert("agent".into(), json!(agent));
    let what = if sub == "marketplace" || sub == "market" {
        let verb = shift(&mut args).unwrap_or_default();
        let op = market_op(&verb);
        let arg = shift(&mut args).filter(|a| !a.is_empty());
        let (Some(op), Some(arg)) = (op, arg) else {
            return Err(PLUGINS_USAGE.into());
        };
        body.insert("op".into(), json!(op));
        let key = if op == "market-add" { "source" } else { "name" };
        body.insert(key.into(), json!(arg));
        arg
    } else {
        let op = plugin_op(&sub);
        let id = shift(&mut args).filter(|a| !a.is_empty());
        let (Some(op), Some(id)) = (op, id) else {
            return Err(PLUGINS_USAGE.into());
        };
        body.insert("op".into(), json!(op));
        body.insert("id".into(), json!(id));
        if let Some(accept) = accept.filter(|a| !a.is_empty()) {
            body.insert("accept".into(), json!(accept));
        }
        id
    };
    let t = owner(out).await?;
    let r = ask
        .ask(&t, "POST", "/api/kit/plugins", Some(&Value::Object(body)))
        .await
        .map_err(|e| did_not_answer(&t.name, &e))?;
    out.lines(op_lines(&r, &what));
    if str_at(&r, "outcome") != Some("ok") {
        out.failed = true;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
