//! `canopy clip` (`src/cli/clips.ts`, FR-054): put text or a file on
//! canopy's clipboard from a shell, an agent or a script, so it shows on
//! every page and device; list the clips every backend keeps; print one to
//! stdout or save it; pin, drop or clear them. Each is a call to the
//! clipboard routes with the caller's token. A pipe that is not text (a NUL
//! byte, or not UTF-8) goes as a file named by its first bytes.
//!
//! What lies outside the JSON routes (a file's bytes up and down, stdin,
//! whether stdin and stdout are terminals, the machine's name) goes through
//! `ClipHost`, so a test stands a fake in for all of it.

use crate::api::Caller;
use crate::ask::{
    Ask, AskError, Client, Target, backend_targets, encode_component, error_of, fetch_words,
    form_query, has, is_origin, take,
};
use crate::out::Out;
use canopy_core::clips::{
    CLIP_FILE_MAX, ago_word, clip_key, clip_line, clip_order, decode_utf8, kind_of, looks_secret,
    looks_secret_file, size_word, sniff_type, text_head,
};
use canopy_core::js::{field, num_at, truthy};
use canopy_core::pathx::{basename, pad_end, pad_start};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::io::IsTerminal;
use std::time::Duration;

/// `CLIP_USAGE`.
pub const CLIP_USAGE: &str = "usage: canopy clip \"<text>\"            keep text on the clipboard; with no text, what stdin holds (a picture piped in goes as a file)
       canopy clip --file <path>         keep a file: a picture, a PDF, anything up to 25 MB
       canopy clip list [-n N] [--json]  the newest clips on every backend
       canopy clip get [N | id] [-o path]  print a clip's text, or save a file's bytes (N counts from 1; the newest by default)
       canopy clip pin <id> | unpin <id> | rm <id>
       canopy clip clear                 drop every unpinned clip on the home backend
  --backend URL asks only that address ($CANOPY_API, else 127.0.0.1:7850); --on NAME keeps one backend";

const SUBS: &[&str] = &[
    "put", "list", "ls", "get", "pin", "unpin", "rm", "delete", "clear",
];

/// how long a file's bytes may take up or down
const FILE_TIMEOUT: Duration = Duration::from_millis(120_000);

/// `clipWords()`: the words of `canopy clip <text…>` and `canopy clip put
/// <text…>` as they were typed, once --backend and --on are out. A text
/// that has begun owns every word after it. None for every other form: a
/// sub-command, a flag first, or `put --file <path>`.
pub fn clip_words(args: &[String]) -> Option<Vec<String>> {
    let first = args.first()?;
    if first == "put" {
        let rest = &args[1..];
        return match rest.first().map(String::as_str) {
            Some("--file" | "-f") => None,
            _ => Some(rest.to_vec()),
        };
    }
    (!SUBS.contains(&first.as_str()) && !first.starts_with('-')).then(|| args.to_vec())
}

/// `HeldClip`: a clip with the backend that keeps it.
#[derive(Debug, Clone, PartialEq)]
pub struct Held {
    pub clip: Value,
    pub backend: String,
}

/// `mergeHeld()`: every backend's clips as one list, newest first; the
/// same text, or the same file, on two backends shows once, the newest copy.
pub fn merge_held(lists: &[(String, Vec<Value>)]) -> Vec<Held> {
    let all: Vec<Held> = lists
        .iter()
        .flat_map(|(backend, clips)| {
            clips.iter().map(move |c| Held {
                clip: c.clone(),
                backend: backend.clone(),
            })
        })
        .collect();
    let mut order: Vec<usize> = (0..all.len()).collect();
    order.sort_by(|a, b| clip_order(&all[*a].clip, &all[*b].clip));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for i in order {
        if seen.insert(clip_key(&all[i].clip)) {
            out.push(all[i].clone());
        }
    }
    out
}

/// A clip's file, when it has one.
fn file_of(c: &Value) -> Option<&Value> {
    c.get("file").filter(|f| truthy(Some(f)))
}

/// `clipLines()`: `n  id  when  source  kind  text`, newest first; the
/// backend after the source when there are several.
pub fn clip_lines(held: &[Held], now: f64, several: bool) -> Vec<String> {
    held.iter()
        .enumerate()
        .map(|(i, h)| {
            let c = &h.clip;
            let pin = if truthy(c.get("pinned")) { "*" } else { " " };
            let place = if several {
                format!("{}@{}", field(c, "source"), h.backend)
            } else {
                field(c, "source")
            };
            let what = match file_of(c) {
                Some(f) => format!(
                    "{}  {}",
                    clip_line(&field(f, "name"), 80),
                    size_word(num_at(f, "size").unwrap_or(f64::NAN))
                ),
                None => clip_line(&field(c, "text"), 90),
            };
            format!(
                "{}{pin} {}  {}  {} {} {what}",
                pad_start(&(i + 1).to_string(), 3),
                field(c, "id"),
                pad_start(&ago_word(num_at(c, "at").unwrap_or(f64::NAN), now), 3),
                pad_end(&place, if several { 18 } else { 9 }),
                pad_end(kind_of(c), 7)
            )
        })
        .collect()
}

/// `pickHeld()`: the clip a reference names, a count from 1 in the list or
/// an id; the newest with none.
pub fn pick_held<'a>(held: &'a [Held], r: Option<&str>) -> Option<&'a Held> {
    let Some(r) = r else {
        return held.first();
    };
    if !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()) {
        let n: f64 = r.parse().unwrap_or(f64::NAN);
        if n >= 1.0 && n - 1.0 < held.len() as f64 {
            return held.get((n - 1.0) as usize);
        }
        return None;
    }
    held.iter()
        .find(|h| h.clip.get("id").and_then(Value::as_str) == Some(r))
}

/// `cliFrom()`: what a clip from here says it came from, the canopy shell's
/// repo, else this machine.
pub fn cli_from(repo: Option<&str>, run: Option<&str>, host: &str) -> String {
    let place = match repo.filter(|r| !r.is_empty()) {
        Some(r) => basename(r.trim_end_matches('/')),
        None => host.to_string(),
    };
    if run.is_some_and(|r| !r.is_empty()) {
        format!("{place} (run)")
    } else {
        place
    }
}

/// `Bun.file(path).type`: the media type Bun gives a name by its extension.
pub fn bun_type(name: &str) -> &'static str {
    let base = basename(name);
    let ext = match base.rfind('.') {
        Some(i) if i > 0 => base[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    };
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/x-ms-bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "psd" => "image/vnd.adobe.photoshop",
        "pdf" => "application/pdf",
        "txt" | "log" | "conf" | "ini" => "text/plain;charset=utf-8",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json;charset=utf-8",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" | "htm" => "text/html;charset=utf-8",
        "css" => "text/css;charset=utf-8",
        "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" => "text/javascript;charset=utf-8",
        "xml" => "application/xml",
        "yaml" | "yml" => "text/yaml",
        "toml" => "application/toml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/x-rar-compressed",
        "bz2" => "application/x-bzip2",
        "xz" => "application/x-xz",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "m4v" => "video/x-m4v",
        "3gp" => "video/3gpp",
        "mpeg" | "mpg" => "video/mpeg",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/x-m4a",
        "wav" => "audio/x-wav",
        "ogg" | "opus" | "oga" => "audio/ogg",
        "flac" => "audio/x-flac",
        "aac" => "audio/x-aac",
        "midi" | "mid" => "audio/midi",
        "aiff" => "audio/x-aiff",
        "wma" => "audio/x-ms-wma",
        "amr" => "audio/amr",
        "sh" => "application/x-sh",
        "wasm" => "application/wasm",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "odp" => "application/vnd.oasis.opendocument.presentation",
        "rtf" => "text/rtf",
        "epub" => "application/epub+zip",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "sql" => "application/x-sql",
        "c" | "h" | "cpp" => "text/x-c",
        "java" => "text/x-java-source",
        "php" => "application/x-httpd-php",
        "pl" => "application/x-perl",
        "lua" => "text/x-lua",
        "scss" => "text/x-scss",
        "sass" => "text/x-sass",
        "less" => "text/less",
        "dart" => "application/vnd.dart",
        "jar" => "application/java-archive",
        "apk" => "application/vnd.android.package-archive",
        "deb" => "application/x-debian-package",
        "rpm" => "application/x-redhat-package-manager",
        "dmg" => "application/x-apple-diskimage",
        "exe" => "application/x-msdownload",
        "iso" => "application/x-iso9660-image",
        "ics" => "text/calendar",
        "vcf" => "text/x-vcard",
        "eml" => "message/rfc822",
        "ai" | "eps" => "application/postscript",
        "pages" => "application/x-iwork-pages-sffpages",
        "numbers" => "application/x-iwork-numbers-sffnumbers",
        "key" => "application/x-iwork-keynote-sffkey",
        "pem" => "application/x-x509-ca-cert",
        "rs" => "application/rls-services+xml",
        _ => "application/octet-stream",
    }
}

/// Everything `canopy clip` reaches past the JSON routes.
pub(crate) trait ClipHost {
    /// `!process.stdin.isTTY`
    fn piped(&self) -> bool;
    /// `process.stdout.isTTY`
    fn stdout_tty(&self) -> bool;
    /// `Bun.stdin.arrayBuffer()`
    fn read_stdin(&self) -> Vec<u8>;
    /// `cliFrom(process.env, hostname())`
    fn from(&self) -> String;
    /// `sendFile()`: a file's bytes sent to the home backend as a clip.
    async fn send_file(
        &self,
        home: &str,
        bytes: &[u8],
        name: &str,
        kind: &str,
        from: &str,
    ) -> Result<Value, String>;
    /// `fetchFile()`: a kept file's bytes from the backend that keeps it.
    async fn fetch_file(&self, t: &Target, id: &str) -> Result<Vec<u8>, String>;
}

/// The process's own terminal, stdin, environment and network. A file's
/// bytes go up and come down on the verbs' shared client.
pub(crate) struct Real {
    client: Client,
}

impl Real {
    pub fn new(caller: Caller) -> Self {
        Real {
            client: Client::new(caller),
        }
    }
}

impl ClipHost for Real {
    fn piped(&self) -> bool {
        !std::io::stdin().is_terminal()
    }

    fn stdout_tty(&self) -> bool {
        std::io::stdout().is_terminal()
    }

    fn read_stdin(&self) -> Vec<u8> {
        use std::io::Read as _;
        let mut buf = Vec::new();
        let _ = std::io::stdin().read_to_end(&mut buf);
        buf
    }

    fn from(&self) -> String {
        let env = |k: &str| std::env::var(k).ok();
        cli_from(
            env("CANOPY_REPO").as_deref(),
            env("CANOPY_RUN").as_deref(),
            &crate::pair::hostname(),
        )
    }

    async fn send_file(
        &self,
        home: &str,
        bytes: &[u8],
        name: &str,
        kind: &str,
        from: &str,
    ) -> Result<Value, String> {
        let q = form_query(&[("name", name), ("source", "cli"), ("from", from)]);
        let url = format!("{home}/api/clips/file?{q}");
        let req = self
            .client
            .request(Method::POST, home, &url, Some(FILE_TIMEOUT))
            .header("content-type", kind)
            .body(bytes.to_vec());
        let res = req.send().await.map_err(|e| fetch_words(&e, &url))?;
        let status = res.status();
        let text = res.text().await.map_err(|e| fetch_words(&e, &url))?;
        let out: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            return Err(
                error_of(&out).unwrap_or_else(|| format!("{home} answered {}", status.as_u16()))
            );
        }
        Ok(out)
    }

    async fn fetch_file(&self, t: &Target, id: &str) -> Result<Vec<u8>, String> {
        let mut tried: Vec<String> = Vec::new();
        for url in &t.urls {
            let full = format!("{url}/api/clips/file?id={}", encode_component(id));
            let req = self
                .client
                .request(Method::GET, url, &full, Some(FILE_TIMEOUT));
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                    continue;
                }
            };
            let status: StatusCode = res.status();
            if status.is_success() {
                return res
                    .bytes()
                    .await
                    .map(|b| b.to_vec())
                    .map_err(|e| fetch_words(&e, &full));
            }
            let text = res.text().await.unwrap_or_default();
            let out: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            return Err(error_of(&out)
                .unwrap_or_else(|| format!("{} answered {}", t.name, status.as_u16())));
        }
        Err(format!("{} did not answer: {}", t.name, tried.join("; ")))
    }
}

/// `fail(errText(err))`.
fn failed(e: AskError) -> String {
    e.message().to_string()
}

/// JavaScript's `Number(s)` for `-n`: a whole number, or None when it is
/// anything else (NaN, a fraction, Infinity).
fn whole_number(s: &str) -> Option<f64> {
    Some(canopy_core::js::number_of(s)).filter(|n| n.is_finite() && n.fract() == 0.0)
}

/// `clipCommand()`. A file's bytes printed to stdout go to `raw`, which
/// main writes as they are.
pub(crate) async fn clip_cmd(
    mut args: Vec<String>,
    caller: &Caller,
    ask: &impl Ask,
    host: &impl ClipHost,
    out: &mut Out,
    raw: &mut Vec<u8>,
    now: f64,
) -> Result<(), String> {
    let given = take(&mut args, "--backend");
    let on = take(&mut args, "--on");
    // a text's own words are never clip's flags
    let typed = clip_words(&args);
    let (n, file_path, out_path, as_json) = if typed.is_some() {
        (None, None, None, false)
    } else {
        let n = take(&mut args, "-n");
        let file = take(&mut args, "--file").or_else(|| take(&mut args, "-f"));
        let o = take(&mut args, "-o");
        let j = has(&mut args, "--json");
        (n, file, o, j)
    };
    let home = caller.api_base(given.as_deref());
    if !is_origin(&home) {
        return Err(format!("--backend must be an http(s) origin, got {home}"));
    }
    let home_target = Target::home(&home);
    let sub: Option<String> = if typed.is_some() {
        Some("put".into())
    } else if args.first().is_some_and(|a| SUBS.contains(&a.as_str())) {
        Some(args.remove(0))
    } else {
        None
    };
    let sub = sub.as_deref();
    let piped = host.piped();

    if let Some(path) = file_path {
        if sub.is_some_and(|s| s != "put") || !args.is_empty() {
            return Err(CLIP_USAGE.into());
        }
        let is_file = std::fs::metadata(&path).is_ok_and(|m| !m.is_dir());
        if !is_file {
            return Err(format!("no file at {path}"));
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        return put_file(host, &home, out, &bytes, &basename(&path), bun_type(&path)).await;
    }

    // `canopy clip words…`, `canopy clip put words…`, or what stdin holds:
    // text as text, anything else (a picture piped in) as a file
    if sub == Some("put") || (sub.is_none() && (!args.is_empty() || piped)) {
        let words = typed.unwrap_or(args);
        if !words.is_empty() {
            return put(ask, host, &home_target, out, &words.join(" ")).await;
        }
        let bytes = host.read_stdin();
        if text_head(&bytes).is_some() {
            return put(ask, host, &home_target, out, &decode_utf8(&bytes)).await;
        }
        let (kind, ext) = sniff_type(&bytes).unwrap_or(("application/octet-stream", "bin"));
        return put_file(host, &home, out, &bytes, &format!("clip.{ext}"), kind).await;
    }

    let given_backend = given.is_some();
    let (home_ref, on_ref) = (home.as_str(), on.as_deref());
    let read = move || async move {
        let targets = backend_targets(ask, home_ref, given_backend, on_ref).await?;
        let mut got: Vec<(String, Vec<Value>)> = Vec::new();
        for t in &targets {
            let Ok(info) = ask.ask(t, "GET", "/api/clips", None).await else {
                continue;
            };
            match info.get("clips") {
                None | Some(Value::Null) => {}
                Some(Value::Array(clips)) => got.push((t.name.clone(), clips.clone())),
                Some(_) => got.push((t.name.clone(), Vec::new())),
            }
        }
        if got.is_empty() {
            return Err(
                "no backend answered with its clips (an older backend has none)".to_string(),
            );
        }
        let several = got.len() > 1;
        Ok::<_, String>((merge_held(&got), several, targets))
    };

    match sub {
        None | Some("list" | "ls") => {
            if !args.is_empty() {
                return Err(CLIP_USAGE.into());
            }
            let (held, several, _) = read().await?;
            let count = match n {
                None => 20.0,
                Some(n) => whole_number(&n).unwrap_or(f64::NAN),
            };
            if count.is_nan() || count < 1.0 {
                return Err("-n takes a whole number from 1".into());
            }
            let shown: Vec<Held> = held.into_iter().take(count.min(1e15) as usize).collect();
            if as_json {
                let list: Vec<Value> = shown
                    .iter()
                    .map(|h| json!({"clip": h.clip, "backend": h.backend}))
                    .collect();
                out.line(serde_json::to_string_pretty(&list).unwrap_or_default());
                return Ok(());
            }
            if shown.is_empty() {
                out.line("no clips");
                return Ok(());
            }
            out.lines(clip_lines(&shown, now, several));
            Ok(())
        }
        Some("get") => {
            if args.len() > 1 {
                return Err(CLIP_USAGE.into());
            }
            let (held, _, targets) = read().await?;
            let r = args.first().map(String::as_str);
            let Some(h) = pick_held(&held, r) else {
                return Err(match r {
                    None => "no clips".into(),
                    Some(r) => format!("no clip {r}"),
                });
            };
            let id = field(&h.clip, "id");
            if let Some(file) = file_of(&h.clip) {
                let name = field(file, "name");
                if out_path.is_none() && host.stdout_tty() {
                    return Err(format!(
                        "{id} is a file ({name}, {}); save it with -o {name}, or send it on: canopy clip get {id} > {name}",
                        size_word(num_at(file, "size").unwrap_or(f64::NAN))
                    ));
                }
                let Some(t) = targets.iter().find(|t| t.name == h.backend) else {
                    return Err(format!("no backend {}", h.backend));
                };
                let bytes = host.fetch_file(t, &id).await?;
                let Some(path) = out_path else {
                    raw.extend_from_slice(&bytes);
                    return Ok(());
                };
                write_out(&path, &bytes)?;
                out.line(format!(
                    "saved {name} ({}) to {path}",
                    size_word(bytes.len() as f64)
                ));
                return Ok(());
            }
            let text = field(&h.clip, "text");
            if let Some(path) = out_path {
                write_out(&path, text.as_bytes())?;
                out.line(format!("saved {id} to {path}"));
                return Ok(());
            }
            // as it was copied, with no newline added, so `canopy clip get | pbcopy` is exact
            out.write(&text);
            Ok(())
        }
        Some("clear") => {
            if !args.is_empty() {
                return Err(CLIP_USAGE.into());
            }
            let r = ask
                .ask(&home_target, "POST", "/api/clips/clear", None)
                .await
                .map_err(failed)?;
            let gone = r.get("gone").and_then(Value::as_array).map_or(0, Vec::len);
            out.line(if gone == 1 {
                "dropped 1 clip".to_string()
            } else {
                format!("dropped {gone} clips")
            });
            Ok(())
        }
        Some(verb) => {
            // pin, unpin and rm go to whichever backend keeps the id
            let id = match args.as_slice() {
                [id] if !id.is_empty() => id.clone(),
                _ => return Err(CLIP_USAGE.into()),
            };
            let targets = backend_targets(ask, &home, given_backend, on.as_deref()).await?;
            let mut without: Vec<String> = Vec::new();
            let mut trouble: Vec<String> = Vec::new();
            for t in &targets {
                let answer = if verb == "rm" || verb == "delete" {
                    ask.ask(
                        t,
                        "DELETE",
                        &format!("/api/clips?id={}", encode_component(&id)),
                        None,
                    )
                    .await
                    .map(|_| format!("dropped {id}"))
                } else {
                    ask.ask(
                        t,
                        "POST",
                        "/api/clips/pin",
                        Some(&json!({"id": id, "pinned": verb == "pin"})),
                    )
                    .await
                    .map(|c| {
                        let word = if truthy(c.get("pinned")) {
                            "pinned"
                        } else {
                            "unpinned"
                        };
                        format!("{word} {}", field(&c, "id"))
                    })
                };
                match answer {
                    Ok(line) => {
                        out.line(line);
                        return Ok(());
                    }
                    // a backend without the id says so; the next may keep it,
                    // and what went wrong elsewhere is said once all were asked
                    Err(e) if e.message().contains("no clip by that id") => {
                        without.push(t.name.clone())
                    }
                    Err(AskError::Unreachable(m)) => {
                        trouble.push(format!("{} did not answer: {m}", t.name))
                    }
                    Err(e) => trouble.push(format!("{}: {}", t.name, e.message())),
                }
            }
            let mut parts: Vec<String> = Vec::new();
            if !without.is_empty() {
                parts.push(format!("no clip {id} on {}", without.join(", ")));
            }
            parts.extend(trouble);
            Err(parts.join("; "))
        }
    }
}

/// `Bun.write(path, bytes)`, which makes the folders on the way.
fn write_out(path: &str, bytes: &[u8]) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, bytes).map_err(|e| e.to_string())
}

/// `put()`: text kept on the home backend.
async fn put(
    ask: &impl Ask,
    host: &impl ClipHost,
    home: &Target,
    out: &mut Out,
    text: &str,
) -> Result<(), String> {
    if canopy_core::pathx::js_trim(text).is_empty() {
        return Err(CLIP_USAGE.into());
    }
    if looks_secret(text) {
        return Err(
            "that looks like a key or a password; canopy's clipboard never keeps one".into(),
        );
    }
    let body = json!({"text": text, "source": "cli", "from": host.from()});
    let c = ask
        .ask(home, "POST", "/api/clips", Some(&body))
        .await
        .map_err(failed)?;
    out.line(format!(
        "{}  {}  {}",
        field(&c, "id"),
        kind_of(&c),
        clip_line(&field(&c, "text"), 70)
    ));
    Ok(())
}

/// `putFile()`: a file kept on the home backend.
async fn put_file(
    host: &impl ClipHost,
    home: &str,
    out: &mut Out,
    bytes: &[u8],
    name: &str,
    kind: &str,
) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("the file is empty".into());
    }
    if bytes.len() > CLIP_FILE_MAX {
        return Err(format!(
            "a file on the clipboard is at most {}; that one is {}",
            size_word(CLIP_FILE_MAX as f64),
            size_word(bytes.len() as f64)
        ));
    }
    if looks_secret_file(name) {
        return Err(
            "that file looks like a key or a password; canopy's clipboard never keeps one".into(),
        );
    }
    let c = host
        .send_file(home, bytes, name, kind, &host.from())
        .await?;
    let file = file_of(&c);
    let shown = match file.and_then(|f| f.get("name")).filter(|n| !n.is_null()) {
        Some(n) => canopy_core::js::template(Some(n)),
        None => field(&c, "text"),
    };
    let size = match file.and_then(|f| f.get("size")).filter(|n| !n.is_null()) {
        Some(s) => s.as_f64().unwrap_or(f64::NAN),
        None => bytes.len() as f64,
    };
    out.line(format!(
        "{}  {}  {shown}  {}",
        field(&c, "id"),
        kind_of(&c),
        size_word(size)
    ));
    Ok(())
}

#[cfg(test)]
mod tests;
