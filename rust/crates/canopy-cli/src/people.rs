//! `canopy people` (`src/cli/people.ts`, FR-074): who is on a backend,
//! their roles and teams, the invites that sign them in, and who did what.
//! Each is a call to the people routes with the caller's token. A person
//! or a team is named by its id or its name.

use crate::api::Caller;
use crate::ask::{Ask, AskError, form_query, has, is_origin, take};
use crate::jsdate::locale_string;
use crate::out::Out;
use canopy_core::js::{field, list_at, num_at, str_at, truthy_at};
use canopy_core::pathx::{js_len, js_trim, pad_end};
use canopy_core::people::{ROLES, find_person, find_team, is_role, role_words};
use serde_json::{Map, Value, json};

/// `PEOPLE_USAGE`.
pub fn people_usage() -> String {
    let roles: Vec<String> = ROLES
        .iter()
        .map(|r| format!("{r} ({})", role_words(r)))
        .collect();
    [
        "usage: canopy people [list] [--backend URL]",
        "       canopy people add \"<name>\" [--role owner|admin|member|viewer] [--team <team>]... [--no-invite] [--hours N]",
        "       canopy people invite <person> [--hours N]",
        "       canopy people uninvite <person>",
        "       canopy people role <person> <role>",
        "       canopy people rename <person> \"<name>\"",
        "       canopy people team <person> <team>[,<team>...] | none",
        "       canopy people off | on | remove <person>",
        "       canopy people me [--name \"<name>\"]",
        "       canopy people teams",
        "       canopy people teams add \"<name>\" [--folder <path>]...",
        "       canopy people teams set <team> [--name \"<name>\"] [--folder <path>]...",
        "       canopy people teams remove <team>",
        "       canopy people activity [--person <person>] [--limit N]",
        "",
        &format!("roles: {}", roles.join("; ")),
    ]
    .join("\n")
}

/// `takeAll()`: every `--name value` pulled out of args, in order.
pub fn take_all(args: &mut Vec<String>, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(v) = take(args, name) {
        out.push(v);
    }
    out
}

/// `rosterOf()`: the roster the API sent, in the shape the lookups read.
pub fn roster_of(info: &Value) -> Value {
    let people = list_at(info, "people");
    let owner = people
        .iter()
        .find(|p| str_at(p, "role") == Some("owner") && str_at(p, "id") == Some("owner"));
    let mut head = Map::new();
    head.insert(
        "name".into(),
        owner
            .and_then(|o| o.get("name").filter(|n| !n.is_null()))
            .cloned()
            .unwrap_or_else(|| json!("owner")),
    );
    if let Some(c) = owner.and_then(|o| o.get("color")) {
        head.insert("color".into(), c.clone());
    }
    let rest: Vec<Value> = people
        .iter()
        .filter(|p| str_at(p, "id") != Some("owner"))
        .cloned()
        .collect();
    json!({
        "owner": head,
        "people": rest,
        "teams": info.get("teams").cloned().unwrap_or(Value::Null),
        "invites": [],
    })
}

/// `teamNames()`: a person's teams by name, an unknown one by its id.
fn team_names(p: &Value, teams: &[Value]) -> String {
    list_at(p, "teams")
        .iter()
        .map(|id| {
            teams
                .iter()
                .find(|t| t.get("id") == Some(id))
                .and_then(|t| t.get("name").filter(|n| !n.is_null()))
                .map_or_else(
                    || canopy_core::js::template(Some(id)),
                    |n| canopy_core::js::template(Some(n)),
                )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `name.length` of a JSON string, as JavaScript counts it.
fn name_len(v: &Value) -> usize {
    js_len(&field(v, "name"))
}

/// `peopleLines()`: `id  name  role  teams  state`, the owner first.
pub fn people_lines(info: &Value) -> Vec<String> {
    let people = list_at(info, "people");
    let teams = list_at(info, "teams");
    let wide = people.iter().map(name_len).fold(4, usize::max);
    people
        .iter()
        .map(|p| {
            let devices = list_at(p, "devices");
            let invited = num_at(p, "invited").unwrap_or(f64::NAN);
            let mut state: Vec<String> = Vec::new();
            if truthy_at(p, "off") {
                state.push("off".into());
            }
            if !devices.is_empty() {
                let names: Vec<String> = devices.iter().map(|d| field(d, "name")).collect();
                state.push(format!("on: {}", names.join(", ")));
            }
            if invited > 0.0 {
                state.push(format!(
                    "{} invite{} waiting",
                    field(p, "invited"),
                    if invited == 1.0 { "" } else { "s" }
                ));
            }
            let names = team_names(p, teams);
            format!(
                "{}  {}  {}  {}{}",
                pad_end(&field(p, "id"), 10),
                pad_end(&field(p, "name"), wide),
                pad_end(&field(p, "role"), 6),
                if names.is_empty() { "-" } else { &names },
                if state.is_empty() {
                    String::new()
                } else {
                    format!("  ({})", state.join("; "))
                }
            )
        })
        .collect()
}

/// `teamLines()`: `id  name  people  folders`.
pub fn team_lines(info: &Value) -> Vec<String> {
    let people = list_at(info, "people");
    let teams = list_at(info, "teams");
    let wide = teams.iter().map(name_len).fold(4, usize::max);
    teams
        .iter()
        .map(|t| {
            let id = t.get("id");
            let on: Vec<String> = people
                .iter()
                .filter(|p| list_at(p, "teams").iter().any(|x| Some(x) == id))
                .map(|p| field(p, "name"))
                .collect();
            let folders = list_at(t, "folders");
            format!(
                "{}  {}  {}{}",
                field(t, "id"),
                pad_end(&field(t, "name"), wide),
                if on.is_empty() {
                    "nobody".to_string()
                } else {
                    on.join(", ")
                },
                if folders.is_empty() {
                    String::new()
                } else {
                    format!("  {}", canopy_core::js::join(folders, " "))
                }
            )
        })
        .collect()
}

/// `activityLines()`: `when  who  what  repo`, newest first as the backend
/// sends them.
pub fn activity_lines(
    lines: &[Value],
    people: &[Value],
    when: &dyn Fn(f64) -> String,
) -> Vec<String> {
    lines
        .iter()
        .map(|l| {
            let who = l.get("person");
            let name = people
                .iter()
                .find(|p| p.get("id") == who)
                .map_or_else(|| field(l, "person"), |p| field(p, "name"));
            let repo = if truthy_at(l, "repo") {
                format!(" in {}", field(l, "repo"))
            } else {
                String::new()
            };
            let kind = if str_at(l, "kind") == Some("page") {
                String::new()
            } else {
                format!("  ({})", field(l, "kind"))
            };
            let at = num_at(l, "at").unwrap_or(f64::NAN);
            format!("{}  {name}  {}{repo}{kind}", when(at), field(l, "what"))
        })
        .collect()
}

/// `inviteWords()`: how an invite is handed over, the link a browser opens
/// and the CLI's line.
pub fn invite_words(
    home: &str,
    name: &str,
    code: &str,
    expires: f64,
    when: &dyn Fn(f64) -> String,
) -> Vec<String> {
    vec![
        format!("invite for {name}, good once until {}:", when(expires)),
        format!("  in a browser   {home}/?join={code}"),
        format!("  from a shell   canopy auth join {code} --backend {home}"),
    ]
}

/// JavaScript's `Number(s)`: whitespace trimmed, empty is 0, hex, octal and
/// binary with their prefixes, Infinity, else a decimal or NaN.
fn js_to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |p: &str, r: u32| {
        t.strip_prefix(p)
            .or_else(|| t.strip_prefix(&p.to_uppercase()))
            .map(|d| {
                if d.is_empty() || !d.chars().all(|c| c.is_digit(r)) {
                    f64::NAN
                } else {
                    d.chars().fold(0.0, |n, c| {
                        n * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0))
                    })
                }
            })
    };
    if let Some(n) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return n;
    }
    match t.trim_start_matches(['+', '-']) {
        "Infinity" if t.len() - "Infinity".len() <= 1 => {
            return if t.starts_with('-') {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
        }
        _ => {}
    }
    let ok = t
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E'));
    if !ok {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// A number as `JSON.stringify` writes it: a whole one without a point.
fn json_number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `fail(errText(err))`.
fn failed(e: AskError) -> String {
    e.message().to_string()
}

/// `--hours N` out of a command's words; the backend holds it to 1 to 720.
fn hours_in(words: &mut Vec<String>) -> Result<Option<f64>, String> {
    let Some(raw) = take(words, "--hours") else {
        return Ok(None);
    };
    let n = js_to_number(&raw);
    if n.is_finite() && n > 0.0 {
        Ok(Some(n))
    } else {
        Err("--hours is a number of hours, from 1 to 720".into())
    }
}

/// A person by id or name off the roster, or the command fails.
fn person(info: &Value, r: Option<&str>) -> Result<Value, String> {
    match r.filter(|r| !r.is_empty()) {
        None => Err(people_usage()),
        Some(r) => {
            find_person(&roster_of(info), r).ok_or_else(|| format!("nobody here is called {r}"))
        }
    }
}

/// A team by id or name off the roster, or the command fails.
fn team(info: &Value, r: Option<&str>) -> Result<Value, String> {
    match r.filter(|r| !r.is_empty()) {
        None => Err(people_usage()),
        Some(r) => find_team(&roster_of(info), r).ok_or_else(|| format!("no team {r}")),
    }
}

/// `${team.name} (${team.id})` and its folders, when it has any.
fn team_line(t: &Value) -> String {
    let folders = list_at(t, "folders");
    format!(
        "{} ({}){}",
        field(t, "name"),
        field(t, "id"),
        if folders.is_empty() {
            String::new()
        } else {
            format!(": {}", canopy_core::js::join(folders, " "))
        }
    )
}

fn s_if(n: f64) -> &'static str {
    if n == 1.0 { "" } else { "s" }
}

/// `peopleCommand()`.
pub(crate) async fn people_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let home_target = crate::ask::Target::home(&home);
    let target = &home_target;
    let roster = move || async move {
        ask.ask(target, "GET", "/api/people", None)
            .await
            .map_err(failed)
    };
    let post = move |path: &'static str, body: Value| async move {
        ask.ask(target, "POST", path, Some(&body))
            .await
            .map_err(failed)
    };
    let when = locale_string;

    let sub = if args.is_empty() {
        None
    } else {
        Some(args.remove(0))
    };
    let mut rest = args;

    match sub.as_deref() {
        None | Some("list") => {
            let info = roster().await?;
            out.lines(people_lines(&info));
            Ok(())
        }
        Some("add") => {
            let role = take(&mut rest, "--role").unwrap_or_else(|| "member".into());
            let teams = take_all(&mut rest, "--team");
            let bare = has(&mut rest, "--no-invite");
            let hours = hours_in(&mut rest)?;
            let name = js_trim(&rest.join(" ")).to_string();
            if name.is_empty() {
                return Err(people_usage());
            }
            if !is_role(&role) {
                return Err(format!("--role is one of {}", ROLES.join(", ")));
            }
            let mut ids: Vec<Value> = Vec::new();
            if !teams.is_empty() {
                let info = roster().await?;
                for t in &teams {
                    ids.push(
                        team(&info, Some(t))?
                            .get("id")
                            .cloned()
                            .unwrap_or(Value::Null),
                    );
                }
            }
            let mut body = json!({"name": name, "role": role, "teams": ids});
            if !bare {
                body["invite"] = json!(true);
                if let Some(h) = hours {
                    body["hours"] = json_number(h);
                }
            }
            let made = post("/api/people/add", body).await?;
            let p = made.get("person").unwrap_or(&Value::Null);
            out.line(format!(
                "added {} ({}) as {}",
                field(p, "name"),
                field(p, "id"),
                field(p, "role")
            ));
            if let Some(inv) = made
                .get("invite")
                .filter(|i| canopy_core::js::truthy(Some(i)))
            {
                out.lines(invite_words(
                    &home,
                    &field(p, "name"),
                    &field(inv, "code"),
                    num_at(inv, "expires").unwrap_or(f64::NAN),
                    &when,
                ));
            }
            Ok(())
        }
        Some(verb @ ("invite" | "uninvite")) => {
            let hours = hours_in(&mut rest)?;
            if rest.len() > 1 {
                return Err(people_usage());
            }
            let info = roster().await?;
            let p = person(&info, rest.first().map(String::as_str))?;
            let id = p.get("id").cloned().unwrap_or(Value::Null);
            if verb == "uninvite" {
                let r = post("/api/people/uninvite", json!({ "id": id })).await?;
                let n = num_at(&r, "dropped").unwrap_or(f64::NAN);
                out.line(format!(
                    "dropped {} invite{} for {}",
                    field(&r, "dropped"),
                    s_if(n),
                    field(&p, "name")
                ));
                return Ok(());
            }
            let mut body = json!({ "id": id });
            if let Some(h) = hours {
                body["hours"] = json_number(h);
            }
            let r = post("/api/people/invite", body).await?;
            out.lines(invite_words(
                &home,
                &field(&p, "name"),
                &field(&r, "code"),
                num_at(&r, "expires").unwrap_or(f64::NAN),
                &when,
            ));
            Ok(())
        }
        Some(verb @ ("role" | "rename" | "team")) => {
            let r = rest.first().cloned();
            let value = js_trim(&rest.get(1..).unwrap_or(&[]).join(" ")).to_string();
            let Some(r) = r.filter(|r| !r.is_empty() && !value.is_empty()) else {
                return Err(people_usage());
            };
            let info = roster().await?;
            let p = person(&info, Some(&r))?;
            if verb == "role" && !is_role(&value) {
                return Err(format!("a role is one of {}", ROLES.join(", ")));
            }
            let mut body = json!({ "id": p.get("id").cloned().unwrap_or(Value::Null) });
            match verb {
                "role" => body["role"] = json!(value),
                "rename" => body["name"] = json!(value),
                _ => {
                    let mut ids: Vec<Value> = Vec::new();
                    if value != "none" {
                        for t in value.split(',') {
                            ids.push(
                                team(&info, Some(js_trim(t)))?
                                    .get("id")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                            );
                        }
                    }
                    body["teams"] = Value::Array(ids);
                }
            }
            let r = post("/api/people/set", body).await?;
            let changed = r.get("person").unwrap_or(&Value::Null);
            let on = if list_at(changed, "teams").is_empty() {
                String::new()
            } else {
                format!(", on {}", team_names(changed, list_at(&info, "teams")))
            };
            out.line(format!(
                "{}: {}{on}",
                field(changed, "name"),
                field(changed, "role")
            ));
            Ok(())
        }
        Some(verb @ ("off" | "on" | "remove" | "rm")) => {
            if rest.len() > 1 {
                return Err(people_usage());
            }
            let info = roster().await?;
            let p = person(&info, rest.first().map(String::as_str))?;
            let id = p.get("id").cloned().unwrap_or(Value::Null);
            let name = field(&p, "name");
            if verb == "remove" || verb == "rm" {
                post("/api/people/remove", json!({ "id": id })).await?;
                out.line(format!(
                    "removed {name}; their sessions, shells' tokens and invites are gone"
                ));
                return Ok(());
            }
            post("/api/people/set", json!({ "id": id, "off": verb == "off" })).await?;
            out.line(if verb == "off" {
                format!("{name} is off: every session of theirs is signed out")
            } else {
                format!("{name} is on again; invite them to sign back in")
            });
            Ok(())
        }
        Some("me") => {
            let name = take(&mut rest, "--name");
            if !rest.is_empty() {
                return Err(people_usage());
            }
            if let Some(name) = name {
                let r = post("/api/people/me", json!({ "name": name })).await?;
                let p = r.get("person").unwrap_or(&Value::Null);
                out.line(format!(
                    "you are {} ({})",
                    field(p, "name"),
                    field(p, "role")
                ));
                return Ok(());
            }
            let auth = ask
                .ask(target, "GET", "/api/auth", None)
                .await
                .map_err(failed)?;
            let Some(p) = auth
                .get("person")
                .filter(|p| canopy_core::js::truthy(Some(p)))
            else {
                return Err(
                    "nobody is signed in here; run canopy auth login, or canopy auth join <code>"
                        .into(),
                );
            };
            let rights = canopy_core::js::join(list_at(&auth, "rights"), ", ");
            out.line(format!(
                "{} ({}), {}; this token holds {}",
                field(p, "name"),
                field(p, "id"),
                field(p, "role"),
                if rights.is_empty() {
                    "nothing"
                } else {
                    &rights
                }
            ));
            Ok(())
        }
        Some("teams") => {
            let verb = if rest.is_empty() {
                None
            } else {
                Some(rest.remove(0))
            };
            let mut words = rest;
            let Some(verb) = verb else {
                let info = roster().await?;
                if list_at(&info, "teams").is_empty() {
                    out.line("no teams");
                    return Ok(());
                }
                out.lines(team_lines(&info));
                return Ok(());
            };
            let folders = take_all(&mut words, "--folder");
            let name = take(&mut words, "--name");
            match verb.as_str() {
                "add" => {
                    let called = js_trim(&name.unwrap_or_else(|| words.join(" "))).to_string();
                    if called.is_empty() {
                        return Err(people_usage());
                    }
                    let r = post(
                        "/api/people/team",
                        json!({ "name": called, "folders": folders }),
                    )
                    .await?;
                    out.line(format!(
                        "made {}",
                        team_line(r.get("team").unwrap_or(&Value::Null))
                    ));
                    Ok(())
                }
                "set" | "remove" | "rm" => {
                    if words.len() > 1 {
                        return Err(people_usage());
                    }
                    let info = roster().await?;
                    let t = team(&info, words.first().map(String::as_str))?;
                    let id = t.get("id").cloned().unwrap_or(Value::Null);
                    if verb != "set" {
                        post("/api/people/team/remove", json!({ "id": id })).await?;
                        out.line(format!("removed {}", field(&t, "name")));
                        return Ok(());
                    }
                    if name.is_none() && folders.is_empty() {
                        return Err(people_usage());
                    }
                    let mut body = json!({ "id": id });
                    if let Some(n) = name {
                        body["name"] = json!(n);
                    }
                    if !folders.is_empty() {
                        body["folders"] = json!(folders);
                    }
                    let r = post("/api/people/team", body).await?;
                    out.line(team_line(r.get("team").unwrap_or(&Value::Null)));
                    Ok(())
                }
                _ => Err(people_usage()),
            }
        }
        Some("activity") => {
            let who = take(&mut rest, "--person");
            let limit = take(&mut rest, "--limit");
            if !rest.is_empty() {
                return Err(people_usage());
            }
            let info = roster().await?;
            let id = match &who {
                None => None,
                Some(w) => Some(field(&person(&info, Some(w))?, "id")),
            };
            let mut pairs: Vec<(&str, &str)> = Vec::new();
            if let Some(id) = id.as_deref().filter(|i| !i.is_empty()) {
                pairs.push(("person", id));
            }
            if let Some(l) = limit.as_deref().filter(|l| !l.is_empty()) {
                pairs.push(("limit", l));
            }
            let q = form_query(&pairs);
            let path = if q.is_empty() {
                "/api/people/activity".to_string()
            } else {
                format!("/api/people/activity?{q}")
            };
            let r = ask.ask(target, "GET", &path, None).await.map_err(failed)?;
            let lines = list_at(&r, "lines");
            if lines.is_empty() {
                out.line("nothing yet");
                return Ok(());
            }
            out.lines(activity_lines(lines, list_at(&info, "people"), &when));
            Ok(())
        }
        _ => Err(people_usage()),
    }
}

#[cfg(test)]
mod tests;
