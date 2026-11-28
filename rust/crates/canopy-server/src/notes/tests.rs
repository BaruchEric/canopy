//! `src/server/notes.test.ts`, case by case, on the hub's `handle` as the
//! TS tests call theirs, with a clock and ids of the test's own.

use super::*;
use std::sync::Mutex as StdMutex;

const IDS: [&str; 4] = ["n-testaaaa", "n-testbbbb", "n-testcccc", "n-testdddd"];

fn repos() -> Vec<RepoRef> {
    vec![
        ("r1".into(), "/repos/atlas".into()),
        ("r2".into(), "/repos/keel".into()),
    ]
}

struct T {
    hub: Arc<Notes>,
    rx: broadcast::Receiver<String>,
    /// every frame the hub sent, in order
    heard: Vec<Value>,
    dir: String,
    clock: Arc<StdMutex<f64>>,
    _root: tempfile::TempDir,
}

fn hub() -> T {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("n").to_str().unwrap().to_string();
    let (events, rx) = broadcast::channel(64);
    let clock = Arc::new(StdMutex::new(1_000_000.0));
    let c = clock.clone();
    let next = StdMutex::new(0usize);
    let mint = move || {
        let mut i = next.lock().unwrap();
        let id = IDS.get(*i).expect("test id sequence exhausted");
        *i += 1;
        id.to_string()
    };
    let hub = Notes::with(
        &dir,
        events,
        Box::new(move || *c.lock().unwrap()),
        Box::new(mint),
    );
    T {
        hub: Arc::new(hub),
        rx,
        heard: vec![],
        dir,
        clock,
        _root: root,
    }
}

impl T {
    async fn call(&mut self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let body = body.map(|b| b.to_string()).unwrap_or_default();
        let method = Method::from_bytes(method.as_bytes()).unwrap();
        let r = self
            .hub
            .handle(&method, path, query, body.as_bytes(), &repos())
            .await;
        self.drain();
        r
    }

    fn drain(&mut self) {
        while let Ok(f) = self.rx.try_recv() {
            self.heard.push(serde_json::from_str(&f).unwrap());
        }
    }

    fn now(&self) -> f64 {
        *self.clock.lock().unwrap()
    }

    fn tick(&self, ms: f64) {
        *self.clock.lock().unwrap() += ms;
    }

    /// the notes the last frame carried, which must be a notes frame
    fn notes_in(&mut self) -> Vec<Value> {
        self.drain();
        let last = self.heard.last().expect("no notes event");
        assert_eq!(last["type"], "notes");
        last["notes"].as_array().unwrap().clone()
    }

    fn path(&self) -> String {
        format!("{}/notes.json", self.dir)
    }

    fn file(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.path()).unwrap()).unwrap()
    }
}

fn find<'a>(notes: &'a [Value], key: &str, want: &str) -> &'a Value {
    notes.iter().find(|n| n[key] == want).unwrap()
}

fn ids(notes: &[Value]) -> Vec<&str> {
    notes.iter().filter_map(|n| n["id"].as_str()).collect()
}

#[tokio::test]
async fn add_list_edit_done_and_delete_each_written_to_the_file_and_broadcast() {
    let mut t = hub();
    assert_eq!(
        t.call("GET", "/api/notes", None).await.1,
        json!({ "notes": [] })
    );

    let body = json!({ "text": "  ask Eric about atlas ", "repo": "/repos/atlas", "at": "in 30m" });
    let (status, added) = t.call("POST", "/api/notes", Some(body)).await;
    assert_eq!(status, 200);
    let now = t.now();
    assert_eq!(
        added,
        json!({ "id": "n-testaaaa", "text": "ask Eric about atlas", "repoId": "r1", "due": num(now + 30.0 * 60_000.0), "createdAt": num(now) })
    );
    assert_eq!(t.notes_in(), vec![added.clone()]);
    assert_eq!(t.file(), json!([added]));
    // byte for byte as JSON.stringify(notes, null, 2) and a newline, the
    // fields in the order the TypeScript sets them
    assert_eq!(
        std::fs::read_to_string(t.path()).unwrap(),
        "[\n  {\n    \"id\": \"n-testaaaa\",\n    \"text\": \"ask Eric about atlas\",\n    \"createdAt\": 1000000,\n    \"repoId\": \"r1\",\n    \"due\": 2800000\n  }\n]\n"
    );

    let plain = t
        .call("POST", "/api/notes", Some(json!({ "text": "a thought" })))
        .await
        .1;
    assert_eq!(
        plain,
        json!({ "id": "n-testbbbb", "text": "a thought", "createdAt": num(now) })
    );
    assert_eq!(
        t.call("GET", "/api/notes", None).await.1,
        json!({ "notes": [added, plain] })
    );

    let edit =
        json!({ "id": "n-testbbbb", "text": "a better thought", "repo": "r2", "at": "in 1h" });
    let edited = t.call("POST", "/api/notes/edit", Some(edit)).await.1;
    assert_eq!(
        edited,
        json!({ "id": "n-testbbbb", "text": "a better thought", "repoId": "r2", "due": num(now + 3_600_000.0), "createdAt": num(now) })
    );
    let clear = json!({ "id": "n-testbbbb", "repo": null, "at": null });
    let cleared = t.call("POST", "/api/notes/edit", Some(clear)).await.1;
    assert_eq!(
        cleared,
        json!({ "id": "n-testbbbb", "text": "a better thought", "createdAt": num(now) })
    );

    t.tick(10.0);
    let done = t
        .call(
            "POST",
            "/api/notes/done",
            Some(json!({ "id": "n-testaaaa" })),
        )
        .await
        .1;
    assert_eq!(done["doneAt"], num(t.now()));
    let notes = t.notes_in();
    assert_eq!(find(&notes, "id", "n-testaaaa")["doneAt"], num(t.now()));

    let gone = t.call("DELETE", "/api/notes?id=n-testbbbb", None).await.1;
    assert_eq!(gone, json!({ "ok": true }));
    assert_eq!(ids(&t.notes_in()), ["n-testaaaa"]);
    assert_eq!(ids(t.file().as_array().unwrap()), ["n-testaaaa"]);
}

#[tokio::test]
async fn refusals_empty_text_an_unknown_repo_a_time_that_cannot_be_read_an_unknown_id() {
    let mut t = hub();
    let r = t
        .call("POST", "/api/notes", Some(json!({ "text": "   " })))
        .await;
    assert_eq!(r, (400, json!({ "error": "text is required" })));
    let r = t
        .call(
            "POST",
            "/api/notes",
            Some(json!({ "text": "x", "repo": "/nowhere" })),
        )
        .await;
    assert_eq!(
        r,
        (404, json!({ "error": "no repo /nowhere on this backend" }))
    );
    let when = t
        .call(
            "POST",
            "/api/notes",
            Some(json!({ "text": "x", "at": "someday" })),
        )
        .await;
    assert_eq!(when.0, 400);
    assert!(when.1["error"].as_str().unwrap().contains("not a time"));
    let r = t
        .call(
            "POST",
            "/api/notes/done",
            Some(json!({ "id": "n-nosuchid" })),
        )
        .await;
    assert_eq!(r, (404, json!({ "error": "no note by that id" })));
    let r = t
        .call(
            "POST",
            "/api/notes/edit",
            Some(json!({ "id": "n-testaaaa", "text": "x" })),
        )
        .await;
    assert_eq!(r.0, 404);
    let r = t
        .call(
            "POST",
            "/api/notes/edit",
            Some(json!({ "id": "n-testaaaa", "text": "" })),
        )
        .await;
    assert_eq!(r, (400, json!({ "error": "text cannot be empty" })));
    let r = t.call("DELETE", "/api/notes?id=w-wrongkind", None).await;
    assert_eq!(r, (400, json!({ "error": "id must be a note id" })));
    assert_eq!(t.call("GET", "/api/notes/other", None).await.0, 404);
    assert!(t.heard.is_empty());
    // the rest of the words, as the TypeScript says them
    let r = t
        .call(
            "POST",
            "/api/notes",
            Some(json!({ "text": "x", "repo": 3 })),
        )
        .await;
    assert_eq!(
        r,
        (400, json!({ "error": "repo must be a repo id or path" }))
    );
    let r = t
        .call(
            "POST",
            "/api/notes",
            Some(json!({ "text": "x", "at": " " })),
        )
        .await;
    assert_eq!(
        r,
        (
            400,
            json!({ "error": "at must be a time: in 30m, 14:00, or a date and time" })
        )
    );
    let r = t.call("PUT", "/api/notes", None).await;
    assert_eq!(r, (404, json!({ "error": "not found" })));
    let r = t.call("POST", "/api/notes/edit", Some(json!([1]))).await;
    assert_eq!(r, (400, json!({ "error": "id must be a note id" })));
}

#[tokio::test]
async fn a_time_as_unix_ms_is_taken_as_it_is_a_past_one_is_refused() {
    let mut t = hub();
    let at = t.now() + 120_000.0;
    let r = t
        .call("POST", "/api/notes", Some(json!({ "text": "x", "at": at })))
        .await;
    assert_eq!(r.1["due"], num(at));
    let past = t.now() - 1.0;
    let r = t
        .call(
            "POST",
            "/api/notes",
            Some(json!({ "text": "x", "at": past })),
        )
        .await;
    assert_eq!(
        r,
        (
            400,
            json!({ "error": "at must be a time in the future, in unix ms" })
        )
    );
}

#[tokio::test]
async fn the_file_is_read_again_before_a_write_so_another_servers_note_is_kept() {
    let mut t = hub();
    t.call("POST", "/api/notes", Some(json!({ "text": "mine" })))
        .await;
    let theirs = json!({ "id": "n-elsewher", "text": "theirs", "createdAt": 5 });
    let mut mine = t.file().as_array().unwrap().clone();
    mine.push(theirs);
    std::fs::write(t.path(), Value::from(mine).to_string()).unwrap();
    t.call("POST", "/api/notes", Some(json!({ "text": "mine too" })))
        .await;
    assert_eq!(
        ids(&t.notes_in()),
        ["n-testaaaa", "n-elsewher", "n-testbbbb"]
    );
}

#[tokio::test]
async fn a_file_that_cannot_be_read_is_not_an_empty_list_the_note_is_refused_and_the_file_is_left_alone()
 {
    let mut t = hub();
    std::fs::create_dir_all(&t.dir).unwrap();
    // a link to itself: reading it fails (ELOOP) on macOS and Linux alike, as root too
    std::os::unix::fs::symlink("notes.json", t.path()).unwrap();
    let r = t
        .call("POST", "/api/notes", Some(json!({ "text": "fresh" })))
        .await;
    assert_eq!(r.0, 500);
    assert_eq!(
        r.1["error"],
        format!(
            "ELOOP: too many symbolic links encountered, open '{}'",
            t.path()
        )
    );
    assert!(std::fs::symlink_metadata(t.path()).unwrap().is_symlink());
    assert!(t.heard.is_empty());
    std::fs::remove_file(t.path()).unwrap();
    let r = t
        .call("POST", "/api/notes", Some(json!({ "text": "fresh" })))
        .await;
    assert_eq!(r.0, 200);
}

#[tokio::test]
async fn a_file_that_is_not_json_is_read_as_no_notes_and_overwritten_by_the_next_write() {
    let mut t = hub();
    std::fs::create_dir_all(&t.dir).unwrap();
    std::fs::write(t.path(), "{ not json").unwrap();
    assert_eq!(
        t.call("GET", "/api/notes", None).await.1,
        json!({ "notes": [] })
    );
    t.call("POST", "/api/notes", Some(json!({ "text": "fresh" })))
        .await;
    assert_eq!(t.file().as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn a_reminder_whose_time_has_come_is_delivered_once_written_and_broadcast_moving_its_time_brings_it_back()
 {
    let mut t = hub();
    t.call(
        "POST",
        "/api/notes",
        Some(json!({ "text": "soon", "at": "in 1m" })),
    )
    .await;
    t.call(
        "POST",
        "/api/notes",
        Some(json!({ "text": "later", "at": "in 1h" })),
    )
    .await;
    let before = t.heard.len();
    t.hub.remind(t.now()).await.unwrap();
    t.drain();
    assert_eq!(t.heard.len(), before);

    t.tick(61_000.0);
    let delivered = t.hub.remind(t.now()).await.unwrap();
    assert_eq!(ids(&delivered), ["n-testaaaa"]);
    t.drain();
    assert_eq!(t.heard.len(), before + 1);
    let notes = t.notes_in();
    assert_eq!(find(&notes, "text", "soon")["remindedAt"], num(t.now()));
    assert!(find(&notes, "text", "later").get("remindedAt").is_none());
    let file = t.file();
    assert_eq!(
        find(file.as_array().unwrap(), "text", "soon")["remindedAt"],
        num(t.now())
    );

    t.hub.remind(t.now() + 1.0).await.unwrap();
    t.drain();
    assert_eq!(t.heard.len(), before + 1);

    let moved = t
        .call(
            "POST",
            "/api/notes/edit",
            Some(json!({ "id": "n-testaaaa", "at": "in 5m" })),
        )
        .await
        .1;
    assert!(moved.get("remindedAt").is_none());
    t.tick(6.0 * 60_000.0);
    t.hub.remind(t.now()).await.unwrap();
    let notes = t.notes_in();
    assert_eq!(find(&notes, "id", "n-testaaaa")["remindedAt"], num(t.now()));
}

#[tokio::test]
async fn a_done_reminder_is_never_delivered() {
    let mut t = hub();
    t.call(
        "POST",
        "/api/notes",
        Some(json!({ "text": "soon", "at": "in 1m" })),
    )
    .await;
    t.call(
        "POST",
        "/api/notes/done",
        Some(json!({ "id": "n-testaaaa" })),
    )
    .await;
    let before = t.heard.len();
    t.tick(120_000.0);
    t.hub.remind(t.now()).await.unwrap();
    t.drain();
    assert_eq!(t.heard.len(), before);
}

/// The clock `AppState::start` sets runs this loop; here on a short period,
/// so many ticks pass after the one that delivers.
#[tokio::test]
async fn a_due_reminder_is_marked_and_broadcast_once_however_many_ticks_pass() {
    let mut t = hub();
    t.call(
        "POST",
        "/api/notes",
        Some(json!({ "text": "soon", "at": "in 1m" })),
    )
    .await;
    t.tick(120_000.0);
    let before = t.heard.len();
    let ticks = tokio::spawn(remind_every(t.hub.clone(), Duration::from_millis(20)));
    for _ in 0..500 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        t.drain();
        if t.heard.len() > before {
            break;
        }
    }
    assert_eq!(t.heard.len(), before + 1, "no reminder came");
    // ten more ticks
    tokio::time::sleep(Duration::from_millis(200)).await;
    t.drain();
    ticks.abort();
    assert_eq!(t.heard.len(), before + 1, "delivered more than once");
    assert_eq!(t.notes_in()[0]["remindedAt"], num(t.now()));
    assert_eq!(t.file()[0]["remindedAt"], num(t.now()));
}

#[tokio::test]
async fn an_edit_puts_a_new_field_last_and_keeps_an_old_ones_place() {
    let mut t = hub();
    t.call(
        "POST",
        "/api/notes",
        Some(json!({ "text": "soon", "at": "in 1m" })),
    )
    .await;
    t.tick(61_000.0);
    t.hub.remind(t.now()).await.unwrap();
    // remindedAt came last; a repo added now goes after it, as the spread does
    let edit = json!({ "id": "n-testaaaa", "repo": "r1", "text": "sooner" });
    let edited = t.call("POST", "/api/notes/edit", Some(edit)).await.1;
    assert_eq!(
        edited.to_string(),
        r#"{"id":"n-testaaaa","text":"sooner","createdAt":1000000,"due":1060000,"remindedAt":1061000,"repoId":"r1"}"#
    );
    let raw = std::fs::read_to_string(t.path()).unwrap();
    assert!(
        raw.contains("\"remindedAt\": 1061000,\n    \"repoId\": \"r1\"\n"),
        "{raw}"
    );
}
