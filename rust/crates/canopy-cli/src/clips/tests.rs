//! clips.test.ts's cases, and the command run against a fake backend and a
//! fake host (stdin, the terminal, a file's bytes up and down).

use super::*;
use crate::ask::tests::Fake;
use std::cell::RefCell;
use std::sync::Mutex;

fn clip(id: &str, over: Value) -> Value {
    let mut c = json!({"id": id, "text": id, "source": "cli", "createdAt": 1, "at": 1, "count": 1});
    if let (Some(m), Value::Object(o)) = (c.as_object_mut(), over) {
        m.extend(o);
    }
    c
}

fn held(c: Value, backend: &str) -> Held {
    Held {
        clip: c,
        backend: backend.into(),
    }
}

fn words(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

#[test]
fn every_backends_clips_newest_first_the_same_text_once_at_its_newest() {
    let h = merge_held(&[
        (
            "mac".into(),
            vec![
                clip("c-aaaaaaaa", json!({"text": "same", "at": 5})),
                clip("c-bbbbbbbb", json!({"at": 1})),
            ],
        ),
        (
            "mini".into(),
            vec![
                clip("c-cccccccc", json!({"text": "same", "at": 9})),
                clip("c-dddddddd", json!({"at": 3})),
            ],
        ),
    ]);
    let got: Vec<(String, String)> = h
        .iter()
        .map(|h| (field(&h.clip, "id"), h.backend.clone()))
        .collect();
    assert_eq!(
        got,
        [
            ("c-cccccccc".to_string(), "mini".to_string()),
            ("c-dddddddd".into(), "mini".into()),
            ("c-bbbbbbbb".into(), "mac".into()),
        ]
    );
}

#[test]
fn a_numbered_line_per_clip_a_pin_marked_the_backend_named_when_there_are_several() {
    let h = [
        held(
            clip(
                "c-aaaaaaaa",
                json!({"text": "git push", "source": "shell", "at": 0, "pinned": true}),
            ),
            "mac",
        ),
        held(
            clip("c-bbbbbbbb", json!({"text": "https://x.dev/a", "at": 0})),
            "mini",
        ),
    ];
    assert_eq!(
        clip_lines(&h, 120_000.0, false),
        [
            "  1* c-aaaaaaaa   2m  shell     command git push",
            "  2  c-bbbbbbbb   2m  cli       link    https://x.dev/a"
        ]
    );
    assert_eq!(
        clip_lines(&h, 120_000.0, true)[1],
        "  2  c-bbbbbbbb   2m  cli@mini           link    https://x.dev/a"
    );
    assert_eq!(
        field(&pick_held(&h, None).unwrap().clip, "id"),
        "c-aaaaaaaa"
    );
    assert_eq!(
        field(&pick_held(&h, Some("2")).unwrap().clip, "id"),
        "c-bbbbbbbb"
    );
    assert_eq!(pick_held(&h, Some("c-bbbbbbbb")).unwrap().backend, "mini");
    assert!(pick_held(&h, Some("3")).is_none());
    assert!(pick_held(&h, Some("0")).is_none());
}

#[test]
fn a_canopy_shells_repo_a_run_marked_else_the_machine() {
    assert_eq!(
        cli_from(Some("/Users/e/dev/canopy/"), None, "mac"),
        "canopy"
    );
    assert_eq!(
        cli_from(Some("/repos/atlas"), Some("r1"), "mac"),
        "atlas (run)"
    );
    assert_eq!(cli_from(None, None, "macmini-2018"), "macmini-2018");
    assert_eq!(cli_from(Some(""), Some(""), "mac"), "mac");
}

#[test]
fn a_file_shows_its_kind_name_and_size_and_the_same_bytes_on_two_backends_show_once() {
    let file =
        json!({"name": "shot.png", "type": "image/png", "size": 2_400_000, "sha": "a".repeat(64)});
    let mut copy = file.clone();
    copy["name"] = json!("copy.png");
    let h = merge_held(&[
        (
            "mac".into(),
            vec![clip(
                "c-aaaaaaaa",
                json!({"text": "shot.png", "file": file, "at": 5}),
            )],
        ),
        (
            "mini".into(),
            vec![
                clip(
                    "c-bbbbbbbb",
                    json!({"text": "copy.png", "file": copy, "at": 9}),
                ),
                clip("c-cccccccc", json!({"text": "shot.png", "at": 1})),
            ],
        ),
    ]);
    let ids: Vec<String> = h.iter().map(|h| field(&h.clip, "id")).collect();
    assert_eq!(ids, ["c-bbbbbbbb", "c-cccccccc"]);
    assert_eq!(
        clip_lines(&h, 9.0, false)[0],
        "  1  c-bbbbbbbb  now  cli       image   copy.png  2.3 MB"
    );
}

#[test]
fn a_text_that_has_begun_owns_every_word_after_it_clips_own_flags_included() {
    assert_eq!(
        clip_words(&words(&["git", "log", "-n", "5"])),
        Some(words(&["git", "log", "-n", "5"]))
    );
    assert_eq!(
        clip_words(&words(&[
            "put", "tar", "-f", "x.tar", "-o", "out", "--json"
        ])),
        Some(words(&["tar", "-f", "x.tar", "-o", "out", "--json"]))
    );
    assert_eq!(clip_words(&words(&["put", "list"])), Some(words(&["list"])));
    // put alone reads stdin
    assert_eq!(clip_words(&words(&["put"])), Some(vec![]));
}

#[test]
fn a_sub_command_a_flag_first_put_file_and_no_words_at_all_keep_clips_flags() {
    for a in [
        &["list", "-n", "5"][..],
        &["get", "2", "-o", "out.png"],
        &["-n", "5"],
        &["--file", "shot.png"],
        &["put", "--file", "shot.png"],
        &["put", "-f", "shot.png"],
        &[],
    ] {
        assert_eq!(clip_words(&words(a)), None, "{a:?}");
    }
}

#[test]
fn bun_names_a_files_type_by_its_extension() {
    assert_eq!(bun_type("shot.png"), "image/png");
    assert_eq!(bun_type("/a/b/Shot.PNG"), "image/png");
    assert_eq!(bun_type("notes.txt"), "text/plain;charset=utf-8");
    assert_eq!(bun_type("x.tar.gz"), "application/gzip");
    assert_eq!(bun_type(".png"), "application/octet-stream");
    assert_eq!(bun_type("a.b/x"), "application/octet-stream");
    assert_eq!(bun_type("Makefile"), "application/octet-stream");
}

/// A file sent up: the home backend, its bytes, its name, its type and
/// where it came from.
type Sent = (String, Vec<u8>, String, String);

/// A host with no terminal, a stdin given, and files kept in memory.
struct Host {
    piped: bool,
    tty: bool,
    stdin: Vec<u8>,
    sent: RefCell<Vec<Sent>>,
    files: Vec<(String, Vec<u8>)>,
}

impl Host {
    fn new() -> Self {
        Host {
            piped: false,
            tty: false,
            stdin: Vec::new(),
            sent: RefCell::default(),
            files: Vec::new(),
        }
    }
}

impl ClipHost for Host {
    fn piped(&self) -> bool {
        self.piped
    }
    fn stdout_tty(&self) -> bool {
        self.tty
    }
    fn read_stdin(&self) -> Vec<u8> {
        self.stdin.clone()
    }
    fn from(&self) -> String {
        "mac".into()
    }
    async fn send_file(
        &self,
        home: &str,
        bytes: &[u8],
        name: &str,
        kind: &str,
        from: &str,
    ) -> Result<Value, String> {
        self.sent.borrow_mut().push((
            home.into(),
            bytes.to_vec(),
            name.into(),
            format!("{kind} {from}"),
        ));
        if home.contains(":1") {
            return Err(
                "ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into(),
            );
        }
        let ty = kind.split(';').next().unwrap_or("").to_string();
        Ok(
            json!({"id": "c-ffffffff", "text": name, "source": "cli", "file": {"name": name, "type": ty, "size": bytes.len(), "sha": "f".repeat(64)}, "createdAt": 1, "at": 1, "count": 1}),
        )
    }
    async fn fetch_file(&self, t: &Target, id: &str) -> Result<Vec<u8>, String> {
        self.files
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, b)| b.clone())
            .ok_or_else(|| format!("{} answered 404", t.name))
    }
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-clips-test".into(),
        env_api: Some("http://home:7".into()),
        ..Default::default()
    }
}

/// Two backends, mac (home) and mini, each keeping clips; the requests seen.
struct Backends {
    mac: Vec<Value>,
    mini: Option<Vec<Value>>,
    seen: Vec<String>,
}

impl Backends {
    fn answer(
        &mut self,
        t: &Target,
        m: &str,
        p: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError> {
        self.seen.push(format!("{m} {} {p}", t.name));
        if p == "/api/backends" {
            // mini is always listed; with no clips kept it does not answer
            let list = [
                json!({"name": "mac", "tailnet": "http://home:7"}),
                json!({"name": "mini", "tailnet": "http://mini:7"}),
            ];
            return Ok(json!({"self": "mac", "backends": list}));
        }
        let mini = t.name == "mini";
        if mini && self.mini.is_none() {
            return Err(AskError::Unreachable("http://mini:7: ECONNREFUSED".into()));
        }
        let clips = if mini {
            self.mini.as_mut().unwrap()
        } else {
            &mut self.mac
        };
        match (m, p.split('?').next().unwrap_or("")) {
            ("GET", "/api/clips") => Ok(json!({"clips": clips})),
            ("POST", "/api/clips") => {
                let b = body.unwrap();
                let c = clip(
                    "c-eeeeeeee",
                    json!({"text": b["text"], "from": b["from"], "at": 100}),
                );
                clips.insert(0, c.clone());
                Ok(c)
            }
            ("POST", "/api/clips/clear") => {
                let gone: Vec<Value> = clips
                    .iter()
                    .filter(|c| c.get("pinned").is_none())
                    .map(|c| c["id"].clone())
                    .collect();
                clips.retain(|c| c.get("pinned").is_some());
                Ok(json!({"gone": gone}))
            }
            ("POST", "/api/clips/pin") => {
                let b = body.unwrap();
                let Some(c) = clips.iter_mut().find(|c| c["id"] == b["id"]) else {
                    return Err(AskError::Refused {
                        message: "no clip by that id".into(),
                        status: 404,
                    });
                };
                if b["pinned"] == json!(true) {
                    c["pinned"] = json!(true);
                } else {
                    c.as_object_mut().unwrap().remove("pinned");
                }
                Ok(c.clone())
            }
            ("DELETE", "/api/clips") => {
                let id = p.split("id=").nth(1).unwrap_or("");
                let before = clips.len();
                clips.retain(|c| c["id"] != id);
                if clips.len() == before {
                    return Err(AskError::Refused {
                        message: "no clip by that id".into(),
                        status: 404,
                    });
                }
                Ok(json!({"ok": true}))
            }
            _ => Err(AskError::Refused {
                message: "not found".into(),
                status: 404,
            }),
        }
    }
}

async fn run(
    b: &Mutex<Backends>,
    host: &Host,
    args: &[&str],
) -> (Result<(), String>, String, Vec<u8>) {
    let fake = Fake(|t: &Target, m: &str, p: &str, body: Option<&Value>| {
        b.lock().unwrap().answer(t, m, p, body)
    });
    let mut out = Out::default();
    let mut raw = Vec::new();
    let r = clip_cmd(
        words(args),
        &caller(),
        &fake,
        host,
        &mut out,
        &mut raw,
        120_000.0,
    )
    .await;
    (r, out.text, raw)
}

fn two() -> Mutex<Backends> {
    Mutex::new(Backends {
        mac: vec![clip("c-aaaaaaaa", json!({"text": "git push", "at": 0}))],
        mini: Some(vec![clip(
            "c-bbbbbbbb",
            json!({"text": "shot.png", "file": {"name": "shot.png", "type": "image/png", "size": 4, "sha": "b".repeat(64)}, "at": 60_000}),
        )]),
        seen: Vec::new(),
    })
}

#[tokio::test]
async fn text_goes_to_the_home_backend_and_a_secret_never_does() {
    let b = two();
    let host = Host::new();
    let (r, out, _) = run(&b, &host, &["git", "log", "-n", "5"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "c-eeeeeeee  command  git log -n 5\n");
    assert_eq!(b.lock().unwrap().mac[0]["from"], "mac");
    let (r, _, _) = run(
        &b,
        &host,
        &["put", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    )
    .await;
    assert_eq!(
        r,
        Err("that looks like a key or a password; canopy's clipboard never keeps one".into())
    );
    let (r, _, _) = run(&b, &host, &["put", "  "]).await;
    assert_eq!(r, Err(CLIP_USAGE.into()));
    let (r, _, _) = run(&b, &host, &["x", "--backend", "http://x/y"]).await;
    assert_eq!(
        r,
        Err("--backend must be an http(s) origin, got http://x/y".into())
    );
}

#[tokio::test]
async fn a_pipe_of_text_is_text_and_a_picture_piped_in_goes_as_a_file() {
    let b = two();
    let mut host = Host::new();
    host.piped = true;
    host.stdin = b"echo hi\n".to_vec();
    let (r, out, _) = run(&b, &host, &[]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "c-eeeeeeee  command  echo hi\n");
    host.stdin = vec![0x89, 0x50, 0x4e, 0x47, 0, 1, 2];
    let (r, out, _) = run(&b, &host, &["put"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "c-ffffffff  image  clip.png  7 B\n");
    let first = host.sent.borrow()[0].clone();
    assert_eq!(first.2, "clip.png");
    assert_eq!(first.3, "image/png mac");
    host.stdin = vec![0, 0, 0];
    let (_, out, _) = run(&b, &host, &[]).await;
    assert_eq!(out, "c-ffffffff  file  clip.bin  3 B\n");
    host.stdin = Vec::new();
    assert_eq!(run(&b, &host, &[]).await.0, Err(CLIP_USAGE.into()));
}

#[tokio::test]
async fn a_file_from_disk_by_its_name_and_type_never_a_key_or_an_empty_one() {
    let dir = std::env::temp_dir().join(format!("canopy-clips-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let shot = dir.join("shot.png");
    std::fs::write(&shot, [1u8, 2, 3]).unwrap();
    let empty = dir.join("empty.txt");
    std::fs::write(&empty, []).unwrap();
    let key = dir.join("server.pem");
    std::fs::write(&key, b"x").unwrap();
    let p = |x: &std::path::Path| x.to_string_lossy().into_owned();
    let b = two();
    let host = Host::new();
    let (r, out, _) = run(&b, &host, &["--file", &p(&shot)]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "c-ffffffff  image  shot.png  3 B\n");
    assert_eq!(host.sent.borrow()[0].0, "http://home:7");
    assert_eq!(
        run(&b, &host, &["-f", &p(&empty)]).await.0,
        Err("the file is empty".into())
    );
    assert_eq!(
        run(&b, &host, &["put", "--file", &p(&key)]).await.0,
        Err("that file looks like a key or a password; canopy's clipboard never keeps one".into())
    );
    assert_eq!(
        run(&b, &host, &["--file", &p(&dir)]).await.0,
        Err(format!("no file at {}", p(&dir)))
    );
    assert_eq!(
        run(&b, &host, &["list", "--file", &p(&shot)]).await.0,
        Err(CLIP_USAGE.into())
    );
    assert_eq!(
        run(&b, &host, &["--file", &p(&shot), "extra"]).await.0,
        Err(CLIP_USAGE.into())
    );
    assert_eq!(
        run(
            &b,
            &host,
            &["--file", &p(&shot), "--backend", "http://127.0.0.1:1"]
        )
        .await
        .0,
        Err("ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into())
    );
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn the_list_is_every_backends_newest_first_and_counts_its_n() {
    let b = two();
    let host = Host::new();
    let (r, out, _) = run(&b, &host, &["list"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(
        out,
        "  1  c-bbbbbbbb   1m  cli@mini           image   shot.png  4 B\n  2  c-aaaaaaaa   2m  cli@mac            command git push\n"
    );
    let (_, out, _) = run(&b, &host, &["ls", "-n", "1", "--on", "mac"]).await;
    assert_eq!(out, "  1  c-aaaaaaaa   2m  cli       command git push\n");
    let (_, out, _) = run(
        &b,
        &host,
        &["-n", "1", "--json", "--backend", "http://home:7"],
    )
    .await;
    assert_eq!(
        out,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&json!([{"clip": clip("c-aaaaaaaa", json!({"text": "git push", "at": 0})), "backend": "home"}])).unwrap()
        )
    );
    assert_eq!(
        run(&b, &host, &["list", "-n", "0"]).await.0,
        Err("-n takes a whole number from 1".into())
    );
    assert_eq!(
        run(&b, &host, &["list", "-n", "1.5"]).await.0,
        Err("-n takes a whole number from 1".into())
    );
    assert_eq!(
        run(&b, &host, &["list", "extra"]).await.0,
        Err(CLIP_USAGE.into())
    );
    assert_eq!(
        run(&b, &host, &["list", "--on", "far"]).await.0,
        Err("no backend named far; the home backend lists mac, mini".into())
    );
    // mini does not answer: the list is mac's alone, its backend unnamed
    b.lock().unwrap().mini = None;
    b.lock().unwrap().mac.clear();
    let (_, out, _) = run(&b, &host, &["list"]).await;
    assert_eq!(out, "no clips\n");
}

#[tokio::test]
async fn no_backend_with_a_clipboard_says_so() {
    let fake = Fake(|_: &Target, _: &str, p: &str, _: Option<&Value>| {
        if p == "/api/backends" {
            return Ok(json!({}));
        }
        Err(AskError::Refused {
            message: "not found".into(),
            status: 404,
        })
    });
    let mut out = Out::default();
    let mut raw = Vec::new();
    let r = clip_cmd(
        words(&["list"]),
        &caller(),
        &fake,
        &Host::new(),
        &mut out,
        &mut raw,
        0.0,
    )
    .await;
    assert_eq!(
        r,
        Err("no backend answered with its clips (an older backend has none)".into())
    );
}

#[tokio::test]
async fn get_prints_text_as_it_was_copied_and_a_files_bytes_raw_or_to_a_path() {
    let b = two();
    let mut host = Host::new();
    host.files
        .push(("c-bbbbbbbb".into(), vec![0x89, 0x50, 0, 0xff]));
    let (r, out, raw) = run(&b, &host, &["get", "2"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "git push");
    assert!(raw.is_empty());
    let (r, out, raw) = run(&b, &host, &["get"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "");
    assert_eq!(raw, [0x89, 0x50, 0, 0xff]);
    let dir = std::env::temp_dir().join(format!("canopy-clips-get-{}", std::process::id()));
    let to = dir.join("deep/shot.png").to_string_lossy().into_owned();
    let (r, out, _) = run(&b, &host, &["get", "c-bbbbbbbb", "-o", &to]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, format!("saved shot.png (4 B) to {to}\n"));
    assert_eq!(std::fs::read(&to).unwrap(), [0x89, 0x50, 0, 0xff]);
    let text_to = dir.join("t.txt").to_string_lossy().into_owned();
    let (_, out, _) = run(&b, &host, &["get", "c-aaaaaaaa", "-o", &text_to]).await;
    assert_eq!(out, format!("saved c-aaaaaaaa to {text_to}\n"));
    assert_eq!(std::fs::read_to_string(&text_to).unwrap(), "git push");
    std::fs::remove_dir_all(&dir).unwrap();
    host.tty = true;
    assert_eq!(
        run(&b, &host, &["get", "1"]).await.0,
        Err("c-bbbbbbbb is a file (shot.png, 4 B); save it with -o shot.png, or send it on: canopy clip get c-bbbbbbbb > shot.png".into())
    );
    assert_eq!(
        run(&b, &host, &["get", "9"]).await.0,
        Err("no clip 9".into())
    );
    assert_eq!(
        run(&b, &host, &["get", "a", "b"]).await.0,
        Err(CLIP_USAGE.into())
    );
    b.lock().unwrap().mac.clear();
    b.lock().unwrap().mini = Some(vec![]);
    assert_eq!(run(&b, &host, &["get"]).await.0, Err("no clips".into()));
}

#[tokio::test]
async fn pin_and_rm_go_to_whichever_backend_keeps_the_id_and_clear_to_home() {
    let b = two();
    let host = Host::new();
    let (r, out, _) = run(&b, &host, &["pin", "c-bbbbbbbb"]).await;
    assert_eq!(r, Ok(()));
    assert_eq!(out, "pinned c-bbbbbbbb\n");
    let (_, out, _) = run(&b, &host, &["unpin", "c-bbbbbbbb"]).await;
    assert_eq!(out, "unpinned c-bbbbbbbb\n");
    let (_, out, _) = run(&b, &host, &["rm", "c-aaaaaaaa"]).await;
    assert_eq!(out, "dropped c-aaaaaaaa\n");
    assert_eq!(
        run(&b, &host, &["delete", "c-zzzzzzzz"]).await.0,
        Err("no clip c-zzzzzzzz on mac, mini".into())
    );
    assert_eq!(run(&b, &host, &["pin"]).await.0, Err(CLIP_USAGE.into()));
    assert_eq!(
        run(&b, &host, &["pin", "a", "b"]).await.0,
        Err(CLIP_USAGE.into())
    );
    b.lock().unwrap().mini = None;
    assert_eq!(
        run(&b, &host, &["pin", "c-zzzzzzzz"]).await.0,
        Err("no clip c-zzzzzzzz on mac; mini did not answer: http://mini:7: ECONNREFUSED".into())
    );
    b.lock().unwrap().mac = vec![
        clip("c-aaaaaaaa", json!({})),
        clip("c-cccccccc", json!({"pinned": true})),
    ];
    let (_, out, _) = run(&b, &host, &["clear"]).await;
    assert_eq!(out, "dropped 1 clip\n");
    let (_, out, _) = run(&b, &host, &["clear"]).await;
    assert_eq!(out, "dropped 0 clips\n");
    assert_eq!(
        run(&b, &host, &["clear", "x"]).await.0,
        Err(CLIP_USAGE.into())
    );
    let seen = b.lock().unwrap().seen.clone();
    assert!(
        seen.contains(&"POST home /api/clips/clear".to_string()),
        "{seen:?}"
    );
}

#[tokio::test]
async fn a_files_bytes_go_up_and_come_down_with_the_callers_token() {
    use crate::ask::tests::{Stub, json_answer};
    let stub = Stub::start(|s| {
        if s.method == "POST" {
            if s.path.contains("name=bad") {
                return json_answer(413, json!({"error": "too big for this backend"}));
            }
            if s.path.contains("name=quiet") {
                return (500, vec![], String::new());
            }
            return json_answer(
                201,
                json!({"id": "c-ffffffff", "path": s.path, "body": s.body}),
            );
        }
        if s.path.ends_with("id=c-gone") {
            return json_answer(404, json!({"error": "no clip by that id"}));
        }
        if s.path.ends_with("id=c-mute") {
            return (404, vec![], "gone".into());
        }
        (200, vec![], "raw bytes".into())
    })
    .await;
    let caller = Caller {
        config_dir: "/nonexistent/canopy-clips-test".into(),
        env_api: Some(stub.url.clone()),
        flag_token: Some("flag-token".into()),
        ..Default::default()
    };
    let real = Real::new(caller);
    let c = real
        .send_file(&stub.url, b"PNG!", "a b.png", "image/png", "mac (run)")
        .await
        .unwrap();
    assert_eq!(
        c["path"],
        "/api/clips/file?name=a+b.png&source=cli&from=mac+%28run%29"
    );
    assert_eq!(c["body"], "PNG!");
    assert_eq!(
        stub.seen.lock().unwrap()[0].token.as_deref(),
        Some("flag-token")
    );
    assert_eq!(
        real.send_file(&stub.url, b"x", "bad", "text/plain", "m")
            .await,
        Err("too big for this backend".into())
    );
    assert_eq!(
        real.send_file(&stub.url, b"x", "quiet", "text/plain", "m")
            .await,
        Err(format!("{} answered 500", stub.url))
    );
    let t = Target {
        name: "mini".into(),
        urls: vec!["http://127.0.0.1:1".into(), stub.url.clone()],
    };
    assert_eq!(real.fetch_file(&t, "c-a").await, Ok(b"raw bytes".to_vec()));
    assert_eq!(
        real.fetch_file(&t, "c-gone").await,
        Err("no clip by that id".into())
    );
    assert_eq!(
        real.fetch_file(&t, "c-mute").await,
        Err("mini answered 404".into())
    );
    let dead = Target {
        name: "far".into(),
        urls: vec!["http://127.0.0.1:1".into()],
    };
    assert_eq!(
        real.fetch_file(&dead, "c-a").await,
        Err("far did not answer: http://127.0.0.1:1: ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into())
    );
}
