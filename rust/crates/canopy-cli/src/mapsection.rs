//! What the map section's four verbs (`floorplan`, `archify`, `diagnosis`,
//! `understand`) share, each a private copy of a TypeScript helper the
//! port has not reached yet: `selectedTarget`, `repoId`, `isPathArgument`
//! and `folderOf` from src/cli/run.ts, `ageWord` from src/cli/worktrees.ts,
//! `Date.parse` for the ISO times the routes send, and `askText` with the
//! timeout the TypeScript gives it, which ask.rs's trait does not take yet.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Client, Target, did_not_answer, every_target, fetch_words, is_origin,
};
use canopy_core::js::{field, list_at, str_at};
use canopy_core::pathx::resolve_from;
use canopy_core::store::js_number;
use jiff::Timestamp;
use jiff::tz::TimeZone;
use reqwest::{StatusCode, redirect};
use serde_json::Value;
use std::time::Duration;

/// The clock a verb reads and whether it naps: `Date.now()` and
/// `Bun.sleep()` for real, a counter and no naps in a test.
pub(crate) struct Clock<'a> {
    pub now: &'a dyn Fn() -> f64,
    pub naps: bool,
}

impl Clock<'_> {
    /// `Date.now()`.
    pub fn now(&self) -> f64 {
        (self.now)()
    }

    /// `await Bun.sleep(ms)`.
    pub async fn nap(&self, ms: u64) {
        if self.naps {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }
}

/// The folder the CLI runs in, which a path argument and a saved page are
/// read against.
pub(crate) fn here() -> String {
    std::env::current_dir()
        .map(|d| d.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".into())
}

/// `selectedTarget()`: the home backend (`--backend`, else $CANOPY_API,
/// else the local one), or the one `--on` names from the home backend's
/// list. Unlike the listing verbs, a home backend that does not answer
/// the list is a failure here.
pub(crate) async fn selected_target(
    ask: &impl Ask,
    caller: &Caller,
    backend: Option<&str>,
    on: Option<&str>,
) -> Result<Target, String> {
    let home = caller.api_base(backend);
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let Some(name) = on else {
        return Ok(Target::home(&home));
    };
    let targets = every_target(ask, &home)
        .await
        .map_err(|e| did_not_answer("home", &e))?;
    match targets.iter().find(|t| t.name == name) {
        Some(t) => Ok(t.clone()),
        None => Err(format!(
            "no backend named {name}; the home backend lists {}",
            targets
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `isPathArgument()`: ".", or a path that starts with /, ./, ../ or ~: a
/// folder, not a repo's name.
fn is_path_argument(v: &str) -> bool {
    v == "."
        || v.starts_with('/')
        || v.starts_with("./")
        || v.starts_with("../")
        || v.starts_with('~')
}

/// `folderOf()`: a path argument as the real folder it names, `~` read as
/// $HOME, else the failure that says there is none.
fn folder_of(arg: &str, cwd: &str) -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "~".into());
    let tilde = arg == "~" || arg.starts_with("~/");
    let expanded = if tilde {
        format!("{home}{}", &arg[1..])
    } else {
        arg.to_string()
    };
    std::fs::canonicalize(resolve_from(cwd, &expanded))
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| format!("no such folder: {arg}"))
}

/// `repoId()`: a repo's id as typed, or, for a path, the id of the repo the
/// backend scans there.
pub(crate) async fn repo_id(
    ask: &impl Ask,
    repo: &str,
    target: &Target,
    cwd: &str,
) -> Result<String, String> {
    if !is_path_argument(repo) {
        return Ok(repo.to_string());
    }
    let path = folder_of(repo, cwd)?;
    let tree = ask
        .ask(target, "GET", "/api/tree", None)
        .await
        .map_err(|e| did_not_answer(&target.name, &e))?;
    match list_at(&tree, "repos")
        .iter()
        .find(|r| str_at(r, "path") == Some(path.as_str()))
    {
        Some(r) => Ok(field(r, "id")),
        None => Err(format!("{} does not scan {path}", target.name)),
    }
}

const MINUTE: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MINUTE;
const DAY: f64 = 24.0 * HOUR;

/// `ageWord()`: "now", "5m", "2h", "3d". `Math.max(0, NaN)` is NaN, which
/// falls through to days.
pub(crate) fn age_word(ms: f64) -> String {
    let age = if ms.is_nan() { ms } else { ms.max(0.0) };
    if age < MINUTE {
        "now".into()
    } else if age < HOUR {
        format!("{}m", js_number((age / MINUTE).floor()))
    } else if age < DAY {
        format!("{}h", js_number((age / HOUR).floor()))
    } else {
        format!("{}d", js_number((age / DAY).floor()))
    }
}

/// The verbs' `ago` for a unix-ms time: "3h ago", or "just now".
pub(crate) fn ago_ms(now: f64, ms: f64) -> String {
    format!("{} ago", age_word(now - ms)).replacen("now ago", "just now", 1)
}

/// The verbs' `ago` for an ISO time; a time that does not parse stays as
/// it is.
pub(crate) fn ago_iso(now: f64, iso: &str) -> String {
    let t = date_parse(iso);
    if t.is_nan() {
        iso.to_string()
    } else {
        ago_ms(now, t)
    }
}

/// `Date.parse(s)` in the system's zone.
pub(crate) fn date_parse(s: &str) -> f64 {
    date_parse_in(s, &TimeZone::system())
}

/// `Date.parse(s)` for ECMAScript's date-time strings, as Bun's engine
/// reads them: `YYYY[-MM[-DD]]` or `±YYYYYY…`, then `T`, `t` or a space and
/// `HH:mm[:ss[.fff…]]`, then `Z`, `z` or `±HH[:]mm`. A date alone is UTC
/// and a date with a time and no offset is local; a day past its month's
/// end rolls over and 24:00 is the next midnight. NaN for anything else,
/// where the engine would try its legacy formats ("Nov 20 2026"), which
/// the routes never send.
pub(crate) fn date_parse_in(s: &str, tz: &TimeZone) -> f64 {
    iso_ms(s, tz).map_or(f64::NAN, |ms| ms as f64)
}

/// Exactly `n` ASCII digits at `*i`, as a number.
fn digits(b: &[u8], i: &mut usize, n: usize) -> Option<i64> {
    let run = b.get(*i..*i + n)?;
    if !run.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *i += n;
    Some(run.iter().fold(0, |a, d| a * 10 + i64::from(d - b'0')))
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn iso_ms(s: &str, tz: &TimeZone) -> Option<i64> {
    let b = s.as_bytes();
    let mut i = 0;
    let year = match b.first()? {
        sign @ (b'+' | b'-') => {
            i = 1;
            let y = digits(b, &mut i, 6)?;
            match sign {
                // -000000 is not a year
                b'-' if y == 0 => return None,
                b'-' => -y,
                _ => y,
            }
        }
        _ => digits(b, &mut i, 4)?,
    };
    let (mut month, mut day) = (1, 1);
    if b.get(i) == Some(&b'-') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        i += 1;
        month = digits(b, &mut i, 2)?;
        if b.get(i) == Some(&b'-') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
            day = digits(b, &mut i, 2)?;
        }
    }
    let mut time = None;
    if matches!(b.get(i), Some(b'T' | b't' | b' ')) {
        i += 1;
        let h = digits(b, &mut i, 2)?;
        if b.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        let m = digits(b, &mut i, 2)?;
        let (mut sec, mut ms) = (0, 0);
        if b.get(i) == Some(&b':') {
            i += 1;
            sec = digits(b, &mut i, 2)?;
            if b.get(i) == Some(&b'.') {
                i += 1;
                let start = i;
                while b.get(i).is_some_and(u8::is_ascii_digit) {
                    i += 1;
                }
                if i == start {
                    return None;
                }
                // whole milliseconds, the rest cut off
                let frac = format!("{:0<3}", &s[start..i.min(start + 3)]);
                ms = frac.parse().ok()?;
            }
        }
        time = Some((h, m, sec, ms));
    }
    let mut offset = None;
    match b.get(i) {
        Some(b'Z' | b'z') => {
            i += 1;
            offset = Some(0);
        }
        Some(sign @ (b'+' | b'-')) => {
            let sign = if *sign == b'-' { -1 } else { 1 };
            i += 1;
            let oh = digits(b, &mut i, 2)?;
            if b.get(i) == Some(&b':') {
                i += 1;
            }
            let om = digits(b, &mut i, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            offset = Some(sign * (oh * 60 + om));
        }
        _ => {}
    }
    if i != b.len() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (h, m, sec, ms) = time.unwrap_or((0, 0, 0, 0));
    if h > 24 || m > 59 || sec > 59 || (h == 24 && (m, sec, ms) != (0, 0, 0)) {
        return None;
    }
    let wall = (days_from_civil(year, month, 1) + day - 1) * 86_400_000
        + h * 3_600_000
        + m * 60_000
        + sec * 1000
        + ms;
    let t = match (offset, time) {
        (Some(off), _) => wall - off * 60_000,
        (None, None) => wall,
        (None, Some(_)) => {
            let dt = Timestamp::from_millisecond(wall)
                .ok()?
                .to_zoned_datetime(TimeZone::UTC)
                .datetime();
            tz.to_ambiguous_timestamp(dt)
                .compatible()
                .ok()?
                .as_millisecond()
        }
    };
    (t.abs() <= 8_640_000_000_000_000).then_some(t)
}

/// What a start prints: the run's id and verb and how to follow it.
pub(crate) fn started_line(run: &Value) -> String {
    format!(
        "started run {} ({}). Follow it with canopy run show {}; its questions wait in the page.",
        field(run, "id"),
        field(run, "verb"),
        field(run, "id")
    )
}

/// `JSON.stringify(v, null, 2)`.
pub(crate) fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_default()
}

/// `existsSync(file)`, read against the CLI's folder. An empty name is
/// never there.
pub(crate) fn is_there(cwd: &str, file: &str) -> bool {
    !file.is_empty() && std::path::Path::new(&resolve_from(cwd, file)).exists()
}

/// `Bun.write(file, text)`, read against the CLI's folder, its folders
/// made first as Bun makes them.
pub(crate) fn write_page(cwd: &str, file: &str, text: &str) -> Result<(), String> {
    let path = resolve_from(cwd, file);
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// `askText(t, path, timeoutMs)`: a GET whose answer is text, with the
/// timeout the TypeScript gives a page (a minute, two for an analysis).
/// The shared trait's `ask_text` always waits its 8 seconds, so a fake
/// answers through it and the real client through a private copy.
pub(crate) trait AskText: Ask {
    async fn ask_text_within(
        &self,
        t: &Target,
        path: &str,
        timeout: Duration,
    ) -> Result<String, AskError> {
        let _ = timeout;
        self.ask_text(t, path).await
    }
}

impl AskText for Client {
    async fn ask_text_within(
        &self,
        t: &Target,
        path: &str,
        timeout: Duration,
    ) -> Result<String, AskError> {
        text_within(&self.caller, t, path, timeout).await
    }
}

#[cfg(test)]
impl<F> AskText for crate::ask::tests::Fake<F> where
    F: Fn(&Target, &str, &str, Option<&Value>) -> Result<Value, AskError>
{
}

/// `body.key` when the body is a JSON object and the key a string.
fn string_in(body: Option<&Value>, key: &str) -> Option<String> {
    body?.get(key)?.as_str().map(String::from)
}

/// A private copy of `Client::ask_text` in ask.rs with its timeout given:
/// the same addresses, sign-in gates and refusals, on a client of its own.
async fn text_within(
    caller: &Caller,
    t: &Target,
    path: &str,
    timeout: Duration,
) -> Result<String, AskError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let http = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|e| AskError::Denied(e.to_string()))?;
    let mut tried: Vec<String> = Vec::new();
    for url in &t.urls {
        let full = format!("{url}{path}");
        let mut req = http.get(full.as_str()).timeout(timeout);
        if let Some(token) = caller.caller_token(url, None) {
            req = req.header("x-canopy-token", token);
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                continue;
            }
        };
        let status = res.status();
        if status.is_redirection() {
            tried.push(format!("{url}: needs a sign-in"));
            continue;
        }
        let text = match res.text().await {
            Ok(text) => text,
            Err(e) => {
                tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                continue;
            }
        };
        let auth = status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN;
        let auth_body: Option<Value> = if auth {
            serde_json::from_str::<Value>(&text)
                .ok()
                .filter(Value::is_object)
        } else {
            None
        };
        if let Some(need) = string_in(auth_body.as_ref(), "need") {
            return Err(AskError::Denied(
                string_in(auth_body.as_ref(), "error")
                    .unwrap_or_else(|| format!("{} refused: it needs the {need} right", t.name)),
            ));
        }
        if status == StatusCode::UNAUTHORIZED {
            tried.push(format!("{url}: needs a sign-in"));
            continue;
        }
        if !status.is_success() {
            let answered = format!("{} answered {}", t.name, status.as_u16());
            if status == StatusCode::FORBIDDEN {
                return Err(AskError::Denied(
                    string_in(auth_body.as_ref(), "error").unwrap_or(answered),
                ));
            }
            let parsed = serde_json::from_str::<Value>(&text).ok();
            let error = string_in(parsed.as_ref(), "error").unwrap_or(text);
            return Err(AskError::Denied(if error.is_empty() {
                answered
            } else {
                error
            }));
        }
        return Ok(text);
    }
    Err(AskError::Unreachable(if tried.is_empty() {
        "no address".into()
    } else {
        tried.join("; ")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ask::tests::{Fake, Stub};
    use serde_json::json;

    #[test]
    fn age_words_and_ago() {
        assert_eq!(age_word(59_999.0), "now");
        assert_eq!(age_word(-5.0), "now");
        assert_eq!(age_word(5.0 * MINUTE), "5m");
        assert_eq!(age_word(3.0 * HOUR + 1.0), "3h");
        assert_eq!(age_word(49.0 * HOUR), "2d");
        assert_eq!(age_word(f64::NAN), "NaNd");
        assert_eq!(ago_ms(10_000.0, 0.0), "just now");
        assert_eq!(ago_ms(3.0 * HOUR, 0.0), "3h ago");
        let now = 1_795_176_000_000.0; // 2026-11-20T12:00:00Z
        assert_eq!(ago_iso(now, "2026-11-20T09:00:00.000Z"), "3h ago");
        assert_eq!(ago_iso(now, "yesterday-ish"), "yesterday-ish");
    }

    #[test]
    fn date_parse_reads_what_bun_reads() {
        let la = TimeZone::fixed(jiff::tz::offset(-8));
        let p = |s: &str| date_parse_in(s, &la);
        // each value is what Bun printed for Date.parse on a Mac in Los Angeles
        for (s, want) in [
            ("2026-11-20T09:00:00.000Z", 1_795_165_200_000_i64),
            ("2026-11-20", 1_795_132_800_000),
            ("2026-11-20T09:00", 1_795_194_000_000),
            ("2026-11-20 09:00:00", 1_795_194_000_000),
            ("2026-11-20t09:00", 1_795_194_000_000),
            ("2026-11-20T09:00:00+01:00", 1_795_161_600_000),
            ("2026-11-20T09:00:00.000+0100", 1_795_161_600_000),
            ("2026-11-20T09:00:00-08:00", 1_795_194_000_000),
            ("2026-11-20T09:00:00+23:59", 1_795_078_860_000),
            ("2026-11-20T09:00:00.1234Z", 1_795_165_200_123),
            ("2026-11-20T09:00:00.5Z", 1_795_165_200_500),
            ("2026-11-20T09:00Z", 1_795_165_200_000),
            ("2026-11-20 09:00Z", 1_795_165_200_000),
            ("2026-11-20T09:00:00z", 1_795_165_200_000),
            ("2026-11-20Z", 1_795_132_800_000),
            ("+002026-11-20T09:00:00Z", 1_795_165_200_000),
            ("-000001-01-01T00:00:00Z", -62_198_755_200_000),
            ("2026", 1_767_225_600_000),
            ("2026-11", 1_793_491_200_000),
            ("2026-02-30T00:00:00Z", 1_772_409_600_000),
            ("2026-11-31", 1_796_083_200_000),
            ("2026-11-20T24:00:00Z", 1_795_219_200_000),
            ("2026-11-20T23:59:59.999Z", 1_795_219_199_999),
            ("1970-01-01", 0),
            ("+275760-09-13T00:00:00Z", 8_640_000_000_000_000),
        ] {
            assert_eq!(p(s), want as f64, "{s}");
        }
        for s in [
            "garbage",
            "2026-11-20T9:00:00Z",
            "2026-11-20T09:00:60Z",
            "2026-13-01",
            "2026-11-32",
            "2026-00-10",
            "2026-11-00",
            "2026-11-20T24:30:00Z",
            "2026-11-20T24:00:00.001Z",
            "2026-11-20T09:60:00Z",
            "2026-11-20T09:00:00+24:00",
            "2026-11-20T09:00:00+01:60",
            "2026-11-20T09:00:00+01",
            "2026-11-20T09:00:00+1:00",
            "2026-11-20T09:00:00.Z",
            "2026-11-20T09:00:00.",
            "2026-11-20T09:00:00Z ",
            "2026-11-20T",
            "2026-11-20T09",
            "20261120",
            "-000000-01-01T00:00:00Z",
            "+275760-09-13T00:00:00.001Z",
            "275760-09-13",
            "2026-11-20T09:00:00.000Zjunk",
            "",
        ] {
            assert!(p(s).is_nan(), "{s}");
        }
    }

    #[tokio::test]
    async fn a_named_backend_comes_from_the_home_list_and_a_path_from_the_tree() {
        let caller = Caller {
            env_api: Some("http://home.invalid".into()),
            ..Caller::default()
        };
        let dir = std::env::temp_dir().join(format!("canopy-mapsection-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("shop")).unwrap();
        let real = std::fs::canonicalize(dir.join("shop"))
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let tree = json!({"repos": [{"id": "web/shop", "path": real}]});
        let fake = Fake(|t: &Target, _: &str, p: &str, _: Option<&Value>| match p {
            "/api/backends" => Ok::<Value, AskError>(
                json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini.invalid"}]}),
            ),
            "/api/tree" if t.name == "mini" => Ok(tree.clone()),
            _ => Err(AskError::Refused {
                message: "no".into(),
                status: 404,
            }),
        });
        let mini = selected_target(&fake, &caller, None, Some("mini"))
            .await
            .unwrap();
        assert_eq!(mini.urls, ["http://mini.invalid"]);
        assert_eq!(
            selected_target(&fake, &caller, None, Some("pi"))
                .await
                .unwrap_err(),
            "no backend named pi; the home backend lists mac, mini"
        );
        assert_eq!(
            selected_target(&fake, &caller, None, None).await.unwrap(),
            Target::home("http://home.invalid")
        );
        assert_eq!(
            selected_target(&fake, &caller, Some("http://x/y"), None)
                .await
                .unwrap_err(),
            "--backend must be an http(s) origin, got http://x/y"
        );
        let d = dir.to_string_lossy().into_owned();
        assert_eq!(
            repo_id(&fake, "./shop", &mini, &d).await.unwrap(),
            "web/shop"
        );
        assert_eq!(repo_id(&fake, "shop", &mini, &d).await.unwrap(), "shop");
        assert_eq!(
            repo_id(&fake, "./nope", &mini, &d).await.unwrap_err(),
            "no such folder: ./nope"
        );
        assert_eq!(
            repo_id(&fake, ".", &mini, &format!("{d}/shop/.."))
                .await
                .unwrap_err(),
            format!(
                "mini does not scan {}",
                std::fs::canonicalize(&dir).unwrap().to_string_lossy()
            )
        );
        let down = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| {
            Err::<Value, AskError>(AskError::Unreachable("http://home.invalid: refused".into()))
        });
        assert_eq!(
            selected_target(&down, &caller, None, Some("mini"))
                .await
                .unwrap_err(),
            "home did not answer: http://home.invalid: refused"
        );
        assert_eq!(
            repo_id(&down, "./shop", &mini, &d).await.unwrap_err(),
            "mini did not answer: http://home.invalid: refused"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_page_comes_as_text_within_its_own_timeout() {
        let stub = Stub::start(|s| match s.path.as_str() {
            "/page" => (200, vec![], "<html>hi</html>".into()),
            "/gone" => (404, vec![], "{\"error\": \"there is no diagram x\"}".into()),
            _ => (
                403,
                vec![],
                "{\"error\": \"no\", \"need\": \"read\"}".into(),
            ),
        })
        .await;
        let caller = Caller::default();
        let t = Target::home(&stub.url);
        let long = Duration::from_secs(60);
        assert_eq!(
            text_within(&caller, &t, "/page", long).await.unwrap(),
            "<html>hi</html>"
        );
        assert_eq!(
            text_within(&caller, &t, "/gone", long).await.unwrap_err(),
            AskError::Denied("there is no diagram x".into())
        );
        assert_eq!(
            text_within(&caller, &t, "/x", long).await.unwrap_err(),
            AskError::Denied("no".into())
        );
    }
}
