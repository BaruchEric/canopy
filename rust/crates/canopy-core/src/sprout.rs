//! The parts of `src/core/sprout.ts` the CLI's `canopy new` and `canopy
//! incubator` read: a url shown without its secret, a github.com remote and
//! a page inside a repo, a hand-off's review in words, the chain's next
//! step, whether a project has ended, and scout's pick with its limits.
//! A sprout and its review are the JSON a backend sends, read as the
//! TypeScript reads them. The rest of sprout.ts (intake, records, the
//! stages' rules) is not ported yet.

use crate::clips::js_slice;
use crate::js::{field, list_at, num_at, str_at, template, truthy, truthy_at};
use crate::pathx::{JS_S, js_squash_ws, js_trim};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// `oneLine(s, max)`: every run of whitespace one space, trimmed, cut to
/// `max` UTF-16 units.
pub fn one_line(s: &str, max: usize) -> String {
    js_slice(js_trim(&js_squash_ws(s)), max)
}

/// A pattern's letters matched in either case, ASCII only, as JavaScript's
/// `i` flag without `u` folds them.
fn ci(word: &str) -> String {
    word.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex::escape(&c.to_string())
            }
        })
        .collect()
}

/// `[^…\s]` with JavaScript's `\s`: none of `chars` and no whitespace.
fn not_ws(chars: &str) -> String {
    format!("[^{chars}{JS_S}]")
}

/// `^[a-z][a-z0-9+.-]*:\/\/` with the `i` flag.
fn scheme_len(url: &str) -> Option<usize> {
    let b = url.as_bytes();
    if !b.first()?.is_ascii_alphabetic() {
        return None;
    }
    let mut i = 1;
    while i < b.len() && (b[i].is_ascii_alphanumeric() || matches!(b[i], b'+' | b'.' | b'-')) {
        i += 1;
    }
    url[i..].starts_with("://").then_some(i + 3)
}

/// `urlWithoutSecret()`: an http(s) url without its userinfo, any other
/// scheme's url without its password, and anything else as given. Read by
/// a string scan, so a password with a raw `/`, `?` or `#` in it still
/// goes; an `@` in a path or query after a plain host is left alone.
pub fn url_without_secret(url: &str) -> String {
    let Some(n) = scheme_len(url) else {
        return url.to_string();
    };
    let scheme = &url[..n];
    let after = &url[n..];
    // the first `/`, `?` or `#` from `from` on, or the end
    let stop = |from: usize| -> usize {
        after[from..]
            .find(['/', '?', '#'])
            .map_or(after.len(), |i| from + i)
    };
    let head = &after[..stop(0)];
    let at = match head.rfind('@') {
        Some(at) => at,
        None => {
            // an IPv6 literal is a host, never a user
            if head.starts_with('[') {
                return url.to_string();
            }
            let Some(colon) = head.rfind(':') else {
                return url.to_string();
            };
            if head[colon + 1..].bytes().all(|b| b.is_ascii_digit()) {
                return url.to_string();
            }
            let Some(past) = after[head.len()..].find('@').map(|i| head.len() + i) else {
                return url.to_string();
            };
            after[..stop(past + 1)].rfind('@').unwrap_or(past)
        }
    };
    let rest = &after[at + 1..];
    let lower = scheme.to_ascii_lowercase();
    if lower == "http://" || lower == "https://" {
        return format!("{scheme}{rest}");
    }
    let user = after[..at].split(':').next().unwrap_or("");
    let user = if user.is_empty() {
        String::new()
    } else {
        format!("{user}@")
    };
    format!("{scheme}{user}{rest}")
}

static GH_OWNER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$").unwrap());
static GH_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._-]{1,100}$").unwrap());
static GH_FORMS: LazyLock<[Regex; 3]> = LazyLock::new(|| {
    let part = not_ws("/");
    let user = not_ws("@/");
    [
        Regex::new(&format!(
            r"^https://(?:{user}+@)?github\.com/({part}+)/({part}+?)(?:\.git)?/?$"
        ))
        .unwrap(),
        Regex::new(&format!(
            r"^ssh://git@github\.com(?::22)?/({part}+)/({part}+?)(?:\.git)?/?$"
        ))
        .unwrap(),
        Regex::new(&format!(
            r"^git@github\.com:({part}+)/({part}+?)(?:\.git)?/?$"
        ))
        .unwrap(),
    ]
});

/// A github.com repo's owner and name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRepo {
    pub owner: String,
    pub name: String,
}

/// `githubRepo()`: a github.com remote's owner and name, from its https,
/// ssh or scp form; None for any other host, a path, or a url naming more
/// than a repo.
pub fn github_repo(remote: &str) -> Option<GithubRepo> {
    let remote = js_trim(remote);
    for form in GH_FORMS.iter() {
        let Some(m) = form.captures(remote) else {
            continue;
        };
        let owner = m.get(1).map_or("", |g| g.as_str());
        let name = m.get(2).map_or("", |g| g.as_str());
        if !GH_OWNER.is_match(owner) || !GH_NAME.is_match(name) || name == "." || name == ".." {
            return None;
        }
        return Some(GithubRepo {
            owner: owner.into(),
            name: name.into(),
        });
    }
    None
}

/// GitHub's own sections, which sit where an owner's name would
const GH_SECTIONS: &[&str] = &[
    "orgs",
    "users",
    "settings",
    "marketplace",
    "features",
    "topics",
    "collections",
    "sponsors",
    "apps",
    "search",
    "explore",
    "notifications",
    "login",
    "join",
];

static GH_PAGE: LazyLock<Regex> = LazyLock::new(|| {
    let part = not_ws("/?#");
    Regex::new(&format!(
        r"^{http}s?://({user}+@)?(?:{www}\.)?{github}\.{com}/({part}+)/({part}+)([/?#]{rest}*)?$",
        http = ci("http"),
        www = ci("www"),
        github = ci("github"),
        com = ci("com"),
        user = not_ws("@/"),
        rest = not_ws(""),
    ))
    .unwrap()
});
static GH_RAW: LazyLock<Regex> = LazyLock::new(|| {
    let part = not_ws("/?#");
    Regex::new(&format!(
        r"^{http}s?://{raw}\.{host}\.{com}/({part}+)/({part}+)/{rest}+$",
        http = ci("http"),
        raw = ci("raw"),
        host = ci("githubusercontent"),
        com = ci("com"),
        rest = not_ws(""),
    ))
    .unwrap()
});

/// `repoPage()`: a page inside a github.com repo as the repo git clones and
/// the page itself; None for a url that names a repo and nothing more, and
/// for any other host.
pub fn repo_page(url: &str) -> Option<(String, String)> {
    let page = js_trim(url);
    let raw = GH_RAW.captures(page);
    let m = if raw.is_some() {
        None
    } else {
        GH_PAGE.captures(page)
    };
    let group = |c: &Option<regex::Captures>, i: usize| -> String {
        c.as_ref()
            .and_then(|c| c.get(i))
            .map_or(String::new(), |g| g.as_str().to_string())
    };
    let owner = if raw.is_some() {
        group(&raw, 1)
    } else {
        group(&m, 2)
    };
    let full = if raw.is_some() {
        group(&raw, 2)
    } else {
        group(&m, 3)
    };
    let name = match full.len().checked_sub(4) {
        Some(cut) if full[cut..].eq_ignore_ascii_case(".git") => full[..cut].to_string(),
        _ => full,
    };
    if !GH_OWNER.is_match(&owner)
        || !GH_NAME.is_match(&name)
        || name == "."
        || name == ".."
        || GH_SECTIONS.contains(&owner.to_ascii_lowercase().as_str())
    {
        return None;
    }
    // a repo url and nothing after it is not a page
    let rest = if raw.is_some() {
        "/".to_string()
    } else {
        group(&m, 4)
    };
    if raw.is_none() && (rest.is_empty() || rest == "/") {
        return None;
    }
    let user = group(&m, 1);
    Some((
        format!("https://{user}github.com/{owner}/{name}"),
        page.to_string(),
    ))
}

/// `s.slice(0, 12)` of a field, as a template prints it.
fn short(v: &Value, key: &str) -> String {
    js_slice(&field(v, key), 12)
}

/// `handOffText()`: a hand-off's review as the inbox and the sheet show
/// it, the flagged changes first.
pub fn hand_off_text(r: &Value) -> String {
    let remote = field(r, "remote");
    let where_ = match github_repo(&remote) {
        Some(gh) => format!("github.com/{}/{}", gh.owner, gh.name),
        None => remote,
    };
    let mut out: Vec<String> = vec![
        format!(
            "Push {} to {where_}, from {} to {}.",
            field(r, "branch"),
            short(r, "base"),
            short(r, "head")
        ),
        String::new(),
    ];
    let flagged = list_at(r, "flagged");
    if !flagged.is_empty() {
        out.push(
            "Look at these first: a push runs the repo's CI and preview builds with its secrets."
                .into(),
        );
        for f in flagged {
            out.push(format!("! {}", template(Some(f))));
        }
    } else {
        out.push("Nothing in CI, deploy config, hooks or package scripts changed.".into());
    }
    let commits = list_at(r, "commits");
    let more_commits = num_at(r, "moreCommits").unwrap_or(0.0);
    let n = commits.len() as f64 + more_commits;
    out.push(String::new());
    out.push(format!(
        "{} {}:",
        crate::js::number_string(n),
        if n == 1.0 { "commit" } else { "commits" }
    ));
    for c in commits {
        out.push(format!("  {} {}", short(c, "sha"), field(c, "subject")));
    }
    if truthy_at(r, "moreCommits") {
        out.push(format!("  and {} more", field(r, "moreCommits")));
    }
    let files = list_at(r, "files");
    let more_files = num_at(r, "moreFiles").unwrap_or(0.0);
    let n = files.len() as f64 + more_files;
    out.push(String::new());
    out.push(format!(
        "{} {} changed:",
        crate::js::number_string(n),
        if n == 1.0 { "file" } else { "files" }
    ));
    for f in files {
        let counts = match f.get("added") {
            Some(Value::Null) => "bin".to_string(),
            added => {
                let removed = match f.get("removed") {
                    None | Some(Value::Null) => "0".to_string(),
                    v => template(v),
                };
                format!("+{} -{removed}", template(added))
            }
        };
        out.push(format!("  {counts} {}", field(f, "path")));
    }
    if truthy_at(r, "moreFiles") {
        out.push(format!("  and {} more", field(r, "moreFiles")));
    }
    out.join("\n")
}

/// not a workflow: the deploy canopy carries out itself after a new or
/// renovate build
pub const SHIP: &str = "ship";

/// not a workflow: the push of an extend's branch canopy carries out itself
/// after its build
pub const HAND_OFF: &str = "hand-off";

/// `isOwnStep()`: a next step canopy carries out itself, with no stage and
/// no runner.
pub fn is_own_step(name: &str) -> bool {
    name == SHIP || name == HAND_OFF
}

/// `sproutEnded()`.
pub fn sprout_ended(s: &Value) -> bool {
    matches!(
        str_at(s, "status"),
        Some("live" | "rejected" | "handed-off" | "stopped")
    )
}

/// `lastDone()`: the index of the last flow of `workflow` that finished
/// done, or -1.
pub fn last_done(s: &Value, workflow: &str) -> i64 {
    let flows = list_at(s, "flows");
    for (i, f) in flows.iter().enumerate().rev() {
        if str_at(f, "workflow") == Some(workflow) && str_at(f, "outcome") == Some("done") {
            return i as i64;
        }
    }
    -1
}

/// `nextWorkflow()`: what a queued sprout runs next: clarify until it has
/// clarified what is known now, scout until there is a pick, the pick's
/// build after the newest scout, then canopy's own ship, or for an extend
/// its hand-off.
pub fn next_workflow(s: &Value) -> String {
    if !truthy_at(s, "clarified") || truthy_at(s, "reclarify") {
        return "clarify".into();
    }
    let pick = s.get("pick");
    if !truthy(pick) {
        return "scout".into();
    }
    let kind = pick.and_then(|p| str_at(p, "kind"));
    let build = match kind {
        Some("new") => "build-new",
        Some("renovate") => "renovate",
        Some("extend") => "extend",
        _ => "undefined",
    };
    if last_done(s, build) < last_done(s, "scout") {
        return build.into();
    }
    if kind == Some("extend") {
        HAND_OFF.into()
    } else {
        SHIP.into()
    }
}

/// where a sprout may deploy (`HOSTS`)
pub const HOSTS: &[&str] = &["vercel", "vercel+firebase", "vercel+convex", "mini"];
const PICK_KINDS: &[&str] = &["new", "renovate", "extend"];

/// the licenses a renovate pick may carry (SPDX ids)
pub const ALLOWED_LICENSES: &[&str] = &[
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "MPL-2.0",
    "Unlicense",
    "0BSD",
    "GPL-2.0",
    "GPL-3.0",
    "LGPL-2.1",
    "LGPL-3.0",
];

/// the one line a vercel+convex pick parks with
pub const CONVEX_PARKED: &str = "vercel+convex is parked: canopy cannot run a Convex deploy without handing it files outside the project; pick vercel+firebase for a database";
/// the one line a mini pick parks with
pub const MINI_PARKED: &str = "the mini host is not built yet: a stage's compose file would be root on the mini; pick vercel or vercel+firebase";

/// scout's pick, as `parsePick` keeps it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pick {
    pub kind: String,
    pub host: String,
    pub why: String,
    pub target: Option<String>,
    pub license: Option<String>,
}

static HTTPS_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^https://{}+$", not_ws(""))).unwrap());

/// `parsePick()`: scout's `.canopy/pick.json`, read as untrusted: extra
/// keys are dropped, `why` is one line of at most 500, a renovate target is
/// an https url kept without its secret, and a new pick carries no target.
pub fn parse_pick(text: &str) -> Result<Pick, String> {
    let raw: Value = serde_json::from_str(text).map_err(|_| "pick.json is not JSON".to_string())?;
    if !raw.is_object() {
        return Err("pick.json must be an object".into());
    }
    let kind = str_at(&raw, "kind").filter(|k| PICK_KINDS.contains(k));
    let Some(kind) = kind else {
        return Err(format!("kind must be one of {}", PICK_KINDS.join(", ")));
    };
    let Some(host) = str_at(&raw, "host").filter(|h| HOSTS.contains(h)) else {
        return Err(format!("host must be one of {}", HOSTS.join(", ")));
    };
    let why = match str_at(&raw, "why") {
        Some(w) if !js_trim(w).is_empty() => w,
        _ => return Err("why must say in a sentence why this pick".into()),
    };
    let mut pick = Pick {
        kind: kind.into(),
        host: host.into(),
        why: one_line(why, 500),
        target: None,
        license: None,
    };
    let target = str_at(&raw, "target");
    if kind == "renovate" {
        match target {
            Some(t) if HTTPS_URL.is_match(js_trim(t)) => {
                pick.target = Some(url_without_secret(js_trim(t)));
            }
            _ => return Err("a renovate pick needs target: the upstream's https url".into()),
        }
    }
    if kind == "extend" {
        match target {
            Some(t) if !js_trim(t).is_empty() => pick.target = Some(one_line(t, 300)),
            _ => return Err("an extend pick needs target: the repo it extends".into()),
        }
    }
    if let Some(l) = str_at(&raw, "license").filter(|l| !js_trim(l).is_empty()) {
        pick.license = Some(one_line(l, 40));
    }
    Ok(pick)
}

/// `pickRefusal()`: the hard limits on a pick, held in code whatever the
/// judge said.
pub fn pick_refusal(p: &Pick) -> Option<String> {
    if !HOSTS.contains(&p.host.as_str()) {
        return Some(format!(
            "{} is not one of the hosts canopy deploys to",
            p.host
        ));
    }
    if p.kind == "renovate" {
        let Some(license) = p.license.as_deref().filter(|l| !l.is_empty()) else {
            return Some("a renovate pick needs the upstream's SPDX license".into());
        };
        if !ALLOWED_LICENSES.contains(&license) {
            return Some(format!("{license} is not on the allowed license list"));
        }
    }
    None
}

/// `phaseRefusal()`: what this phase can carry out: a new or renovate pick
/// on vercel or vercel+firebase, and an extend, which never deploys.
pub fn phase_refusal(p: &Pick) -> Option<String> {
    if p.kind == "extend" {
        return None;
    }
    match p.host.as_str() {
        "vercel+convex" => Some(CONVEX_PARKED.into()),
        "mini" => Some(MINI_PARKED.into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests;
