//! `canopy ranger` (the `ranger` case in `src/cli/index.ts`): the ranger
//! agent's state, turning it on or off, a restart or a fresh conversation,
//! a message to it over tailchan, and the wakes that start a turn at a
//! time, on a cron line or when a run ends.
//!
//! Every call goes through `Ask::fetch` and is read as that case's own
//! `call` reads it: "<backend> did not answer: <why>", a body that is not
//! JSON as `{}`, and the backend's `error` (else "the backend answered N")
//! as the failure.
//!
//! `leading_when` is `leadingWhen` from core/cron.ts, kept here until
//! canopy-core's cron.rs takes it: that module holds parseWhen's
//! patterns, and ISO_WHEN and leadingWhen are not in it yet.

use crate::api::Caller;
use crate::ask::{Ask, Body, encode_component, is_origin};
use crate::jsdate::date_of;
use crate::out::Out;
use crate::render::Paint;
use canopy_core::js::{
    ascii_ci as ci, field, list_at, number_string, round, str_at, template, truthy_at,
};
use canopy_core::pathx::{JS_S, js_trim, pad_end};
use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

const USAGE: &str = "usage: canopy ranger [status] | on | off | restart | fresh | say <message> | wake <when> <prompt> | unwake <id>";
const SAY_USAGE: &str = "usage: canopy ranger say \"message\"";
const WAKE_USAGE: &str = "usage: canopy ranger wake <when> \"prompt\" | --cron \"0 8 * * *\" \"prompt\" | --run <id> \"prompt\"";
const UNWAKE_USAGE: &str = "usage: canopy ranger unwake <id>";

/// cron.ts's `IN`: `/^in\s+(\d{1,4})\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i`
static IN: LazyLock<Regex> = LazyLock::new(|| {
    let units = [
        "m", "min", "mins", "minute", "minutes", "h", "hr", "hrs", "hour", "hours", "d", "day",
        "days",
    ]
    .map(ci)
    .join("|");
    Regex::new(&format!(
        r"^{}{JS_S}+[0-9]{{1,4}}{JS_S}*(?:{units})$",
        ci("in")
    ))
    .unwrap()
});
/// cron.ts's `CLOCK`: `/^(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)$/i`
static CLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^(?:{}{JS_S}+)?(?:[01]?[0-9]|2[0-3]):[0-5][0-9]$",
        ci("at")
    ))
    .unwrap()
});
/// cron.ts's `ISO_WHEN`
static ISO_WHEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?$").unwrap()
});

/// `leadingWhen()`: the time a command line starts with, in a form the
/// server reads, and the words after it. `in 30m`, `at 14:00` and
/// `2026-10-11 09:00` run to more than one word unquoted, so the longest
/// run of up to three leading words that has a time's shape wins.
pub fn leading_when(words: &[String]) -> Option<(String, Vec<String>)> {
    for n in (1..=words.len().min(3)).rev() {
        let when = words[..n].join(" ");
        if IN.is_match(&when) || CLOCK.is_match(&when) || ISO_WHEN.is_match(&when) {
            return Some((when, words[n..].to_vec()));
        }
    }
    None
}

/// `show()`: the ranger's state, its conversation, its Telegram hold and
/// its wakes.
pub fn show_lines(r: &Value, p: Paint) -> Vec<String> {
    let why = if truthy_at(r, "why") {
        p.dim(&format!(" ({})", field(r, "why")))
    } else {
        String::new()
    };
    let mut out = vec![format!(
        "{} on {}: {}{why}",
        p.bold(&format!("@{}", field(r, "handle"))),
        field(r, "backend"),
        field(r, "state")
    )];
    if truthy_at(r, "session") {
        let size = match r.get("transcriptBytes") {
            None => String::new(),
            Some(b) => {
                let kb = round(b.as_f64().unwrap_or(f64::NAN) / 1024.0);
                format!(", {} KB", number_string(kb))
            }
        };
        out.push(p.dim(&format!("conversation {}{size}", field(r, "session"))));
    }
    if str_at(r, "telegram") != Some("off") {
        out.push(p.dim(&format!("telegram: {}", field(r, "telegram"))));
    }
    for w in list_at(r, "wakes") {
        let when = if truthy_at(w, "cron") {
            format!("cron {}", field(w, "cron"))
        } else if truthy_at(w, "run") {
            format!("when run {} ends", field(w, "run"))
        } else if w.get("next").is_some() {
            date_of(w.get("next"))
        } else {
            String::new()
        };
        out.push(format!(
            "  {}  {} {}  {}",
            p.moss(&field(w, "id")),
            pad_end(&when, 22),
            p.dim(&format!("by {}", field(w, "by"))),
            field(w, "prompt")
        ));
    }
    out
}

/// One call to the backend; a refusal fails the command in the server's
/// words.
async fn call(
    backend: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
    ask: &impl Ask,
) -> Result<Value, String> {
    let r = ask
        .fetch(method, backend, path, body.map(Body::Json), None)
        .await
        .map_err(|e| format!("{backend} did not answer: {e}"))?;
    let out = r.json().unwrap_or_else(|| json!({}));
    if !r.ok() {
        return Err(match out.get("error") {
            None | Some(Value::Null) => format!("the backend answered {}", r.status),
            some => template(some),
        });
    }
    Ok(out)
}

/// The `ranger` case.
pub(crate) async fn ranger_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    out: &mut Out,
    p: Paint,
) -> Result<(), String> {
    let given = crate::opt(&mut args, "--backend");
    let backend = caller.api_base(given.as_deref());
    if !is_origin(&backend) {
        return Err(format!(
            "--backend must be an http(s) origin, got {backend}"
        ));
    }
    let b = backend.as_str();
    let sub = args.first().cloned().unwrap_or_else(|| "status".into());
    match sub.as_str() {
        "status" => {
            let r = call(b, "GET", "/api/ranger", None, ask).await?;
            out.lines(show_lines(&r, p));
        }
        "on" | "off" => {
            let body = json!({"on": sub == "on"});
            let r = call(b, "POST", "/api/ranger", Some(&body), ask).await?;
            out.lines(show_lines(&r, p));
        }
        "restart" | "fresh" => {
            let r = call(b, "POST", &format!("/api/ranger/{sub}"), None, ask).await?;
            out.lines(show_lines(&r, p));
        }
        "say" => {
            let text = js_trim(&args[1..].join(" ")).to_string();
            if text.is_empty() {
                return Err(SAY_USAGE.into());
            }
            let r = call(b, "GET", "/api/ranger", None, ask).await?;
            let handle = field(&r, "handle");
            let body = json!({"target": format!("@{handle}"), "body": text});
            call(b, "POST", "/api/tailchan/send", Some(&body), ask).await?;
            out.line(p.dim(&format!("sent to @{handle}")));
        }
        "wake" => {
            let cron = crate::opt(&mut args, "--cron").filter(|c| !c.is_empty());
            let run = crate::opt(&mut args, "--run").filter(|r| !r.is_empty());
            let mut rest: Vec<String> = args[1..].to_vec();
            let mut when: Option<String> = None;
            if cron.is_none() && run.is_none() {
                // `in 30m` and `at 14:00` are two words unquoted: the time is
                // the longest leading run that reads as one, else the first
                // word, which the server then says it cannot read
                match leading_when(&rest) {
                    Some((w, after)) => {
                        when = Some(w);
                        rest = after;
                    }
                    None => {
                        when = rest.first().cloned();
                        rest = rest.get(1..).map_or(vec![], <[String]>::to_vec);
                    }
                }
            }
            let prompt = js_trim(&rest.join(" ")).to_string();
            let when = when.filter(|w| !w.is_empty());
            if prompt.is_empty() || (cron.is_none() && run.is_none() && when.is_none()) {
                return Err(WAKE_USAGE.into());
            }
            // set from a terminal, it is Eric's: the ranger sets its own through the API
            let mut body = json!({"prompt": prompt, "by": "eric"});
            if let Some(c) = cron {
                body["cron"] = json!(c);
            } else if let Some(r) = run {
                body["run"] = json!(r);
            } else {
                body["when"] = json!(when);
            }
            let w = call(b, "POST", "/api/ranger/wakes", Some(&body), ask).await?;
            let at = if w.get("next").is_some() {
                date_of(w.get("next"))
            } else {
                format!("when run {} ends", field(&w, "run"))
            };
            out.line(format!("{} {at}", p.moss(&field(&w, "id"))));
        }
        "unwake" => {
            let Some(id) = args.get(1).filter(|i| !i.is_empty()) else {
                return Err(UNWAKE_USAGE.into());
            };
            let path = format!("/api/ranger/wakes?id={}", encode_component(id));
            let r = call(b, "DELETE", &path, None, ask).await?;
            out.lines(show_lines(&r, p));
        }
        _ => return Err(USAGE.into()),
    }
    Ok(())
}

#[cfg(test)]
mod tests;
