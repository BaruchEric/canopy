//! people.test.ts's cases. The TypeScript drives the CLI against an
//! enforce server, signing two machines in with `canopy auth`; here a fake
//! backend keeps the roster and answers as the server's people routes and
//! its gate do, and the caller it speaks for is switched by hand.

use super::*;
use crate::ask::Target;
use crate::ask::tests::Fake;
use std::sync::Mutex;

fn here(id: &str, name: &str, role: &str, over: Value) -> Value {
    let mut p = json!({"id": id, "name": name, "role": role, "teams": [], "created": 1, "devices": [], "at": [], "invited": 0});
    if let (Some(m), Value::Object(o)) = (p.as_object_mut(), over) {
        m.extend(o);
    }
    p
}

fn info() -> Value {
    json!({
        "people": [
            here("owner", "Eric", "owner", json!({"devices": [{"id": "a", "name": "Mac", "platform": "mac"}]})),
            here("p-aaaaaaaa", "Avery", "member", json!({"teams": ["t-aaaaaaaa"], "invited": 2})),
            here("p-bbbbbbbb", "Guest", "viewer", json!({"off": true})),
        ],
        "teams": [
            {"id": "t-aaaaaaaa", "name": "Rio", "folders": ["/srv/rio"], "created": 1},
            {"id": "t-bbbbbbbb", "name": "Empty", "folders": [], "created": 1},
        ],
    })
}

fn caller() -> Caller {
    Caller {
        config_dir: "/nonexistent/canopy-people-test".into(),
        // never the local backend, though the fake sends nothing
        env_api: Some("http://home:7".into()),
        ..Default::default()
    }
}

#[test]
fn a_line_a_person_id_name_role_teams_and_what_is_true_of_them_now() {
    assert_eq!(
        people_lines(&info()),
        [
            "owner       Eric   owner   -  (on: Mac)",
            "p-aaaaaaaa  Avery  member  Rio  (2 invites waiting)",
            "p-bbbbbbbb  Guest  viewer  -  (off)",
        ]
    );
}

#[test]
fn a_line_a_team_who_is_on_it_and_where_it_works() {
    assert_eq!(
        team_lines(&info()),
        [
            "t-aaaaaaaa  Rio    Avery  /srv/rio",
            "t-bbbbbbbb  Empty  nobody"
        ]
    );
}

#[test]
fn activity_names_the_person_the_repo_and_a_caller_that_was_not_a_page() {
    let when = |at: f64| format!("t{at}");
    let lines = [
        json!({"at": 2, "person": "p-aaaaaaaa", "kind": "cli", "what": "pushed", "repo": "rio"}),
        json!({"at": 1, "person": "p-gonegone", "kind": "page", "what": "started a run"}),
    ];
    assert_eq!(
        activity_lines(&lines, list_at(&info(), "people"), &when),
        [
            "t2  Avery  pushed in rio  (cli)",
            "t1  p-gonegone  started a run"
        ]
    );
}

#[test]
fn an_invite_is_handed_over_as_a_link_and_as_the_clis_line() {
    let when = |at: f64| format!("t{at}");
    assert_eq!(
        invite_words("https://canopy.example", "Avery", "cnv_abc", 5.0, &when),
        [
            "invite for Avery, good once until t5:",
            "  in a browser   https://canopy.example/?join=cnv_abc",
            "  from a shell   canopy auth join cnv_abc --backend https://canopy.example",
        ]
    );
}

#[test]
fn the_roster_reads_back_as_a_file_the_lookups_take_the_owner_apart() {
    let file = roster_of(&info());
    assert_eq!(file["owner"]["name"], "Eric");
    let ids: Vec<&str> = list_at(&file, "people")
        .iter()
        .filter_map(|p| p["id"].as_str())
        .collect();
    assert_eq!(ids, ["p-aaaaaaaa", "p-bbbbbbbb"]);
}

#[test]
fn a_flag_given_several_times_is_every_value_taken_out_of_the_words() {
    let mut words: Vec<String> = ["Rio", "--folder", "/a", "--name", "x", "--folder", "/b"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(take_all(&mut words, "--folder"), ["/a", "/b"]);
    assert_eq!(words, ["Rio", "--name", "x"]);
}

/// What the fake backend keeps: the roster, the log, and who is calling.
#[derive(Default)]
struct Backend {
    owner_name: String,
    people: Vec<Value>,
    teams: Vec<Value>,
    invites: Vec<(String, String)>,
    log: Vec<Value>,
    /// the person the caller's token is; None for a token that is nobody's
    who: Option<String>,
    seen: Vec<(String, String, Option<Value>)>,
    minted: usize,
}

const RIGHTS_MEMBER: &[&str] = &["read", "plan", "operate"];

impl Backend {
    fn role_of(&self, id: &str) -> Option<String> {
        if id == "owner" {
            return Some("owner".into());
        }
        self.people
            .iter()
            .find(|p| p["id"] == id && p.get("off").is_none())
            .map(|p| p["role"].as_str().unwrap_or("").to_string())
    }

    fn need(&self, right: &str) -> Result<String, AskError> {
        let Some(who) = self.who.clone() else {
            return Err(AskError::Denied(format!(
                "this call needs the {right} right; run canopy auth login, or open a new shell"
            )));
        };
        let Some(role) = self.role_of(&who) else {
            return Err(AskError::Denied(format!(
                "this call needs the {right} right; run canopy auth login, or open a new shell"
            )));
        };
        let holds = match role.as_str() {
            "owner" | "admin" => true,
            "member" => right != "admin",
            _ => right == "read",
        };
        if holds {
            Ok(who)
        } else {
            Err(AskError::Denied(format!(
                "this call needs the {right} right; your role on this backend does not hold it"
            )))
        }
    }

    fn logged(&mut self, who: &str, what: &str) {
        self.log.insert(
            0,
            json!({"at": 1_764_300_000_000u64 + self.log.len() as u64, "person": who, "kind": "cli", "what": what}),
        );
    }

    fn person_here(&self, p: &Value) -> Value {
        let mut out = p.clone();
        let n = self
            .invites
            .iter()
            .filter(|(person, _)| p["id"] == person.as_str())
            .count();
        out["devices"] = json!([]);
        out["at"] = json!([]);
        out["invited"] = json!(n);
        out
    }

    fn invite(&mut self, id: &str) -> Value {
        self.minted += 1;
        let code = format!("cnv_{:a>24}", self.minted);
        self.invites.push((id.to_string(), code.clone()));
        json!({"code": code, "expires": 1_764_400_000_000u64})
    }

    fn answer(
        &mut self,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError> {
        self.seen.push((method.into(), path.into(), body.cloned()));
        let b = body.cloned().unwrap_or(Value::Null);
        let refused = |m: &str, status: u16| {
            Err(AskError::Refused {
                message: m.into(),
                status,
            })
        };
        match (method, path.split('?').next().unwrap_or("")) {
            ("GET", "/api/people") => {
                self.need("read")?;
                let owner = here("owner", &self.owner_name, "owner", json!({}));
                let mut people = vec![owner];
                people.extend(self.people.iter().map(|p| self.person_here(p)));
                Ok(json!({"people": people, "teams": self.teams}))
            }
            ("GET", "/api/auth") => {
                let who = self.who.clone();
                let person = who.as_deref().and_then(|w| {
                    let role = self.role_of(w)?;
                    let name = if w == "owner" {
                        self.owner_name.clone()
                    } else {
                        self.people.iter().find(|p| p["id"] == w)?["name"]
                            .as_str()?
                            .to_string()
                    };
                    Some(json!({"id": w, "name": name, "role": role}))
                });
                let rights: Vec<&str> = match person.as_ref().and_then(|p| p["role"].as_str()) {
                    Some("owner" | "admin") => vec!["read", "plan", "operate", "shell", "admin"],
                    Some("member") => RIGHTS_MEMBER.to_vec(),
                    Some(_) => vec!["read"],
                    None => vec![],
                };
                Ok(json!({"mode": "enforce", "person": person, "rights": rights}))
            }
            ("POST", "/api/people/me") => {
                let who = self.need("read")?;
                let name = b["name"].as_str().unwrap_or("").to_string();
                if who == "owner" {
                    self.owner_name = name.clone();
                }
                Ok(json!({"person": {"id": who, "name": name, "role": self.role_of(&who)}}))
            }
            ("POST", "/api/people/team") => {
                let who = self.need("admin")?;
                self.logged(&who, "changed a team");
                if let Some(id) = b["id"].as_str() {
                    let t = self.teams.iter_mut().find(|t| t["id"] == id).unwrap();
                    if let Some(n) = b.get("name") {
                        t["name"] = n.clone();
                    }
                    if let Some(f) = b.get("folders") {
                        t["folders"] = f.clone();
                    }
                    return Ok(json!({"team": t.clone()}));
                }
                let t = json!({"id": format!("t-{:a>8}", self.teams.len() + 1), "name": b["name"], "folders": b["folders"], "created": 1});
                self.teams.push(t.clone());
                Ok(json!({"team": t}))
            }
            ("POST", "/api/people/team/remove") => {
                let who = self.need("admin")?;
                self.teams.retain(|t| t["id"] != b["id"]);
                self.logged(&who, "removed a team");
                Ok(json!({"ok": true}))
            }
            ("POST", "/api/people/add") => {
                let who = self.need("admin")?;
                let id = format!("p-{:a>8}", self.people.len() + 1);
                let p = json!({"id": id, "name": b["name"], "role": b["role"], "teams": b["teams"], "created": 1});
                self.people.push(p.clone());
                self.logged(&who, "added a person");
                let mut out = json!({"person": p});
                if b["invite"] == json!(true) {
                    out["invite"] = self.invite(&id);
                }
                Ok(out)
            }
            ("POST", "/api/people/set") => {
                let who = self.need("admin")?;
                let Some(p) = self.people.iter_mut().find(|p| p["id"] == b["id"]) else {
                    return refused("nobody by that id", 404);
                };
                if let Some(r) = b.get("role") {
                    p["role"] = r.clone();
                }
                if let Some(n) = b.get("name") {
                    p["name"] = n.clone();
                }
                if let Some(t) = b.get("teams") {
                    p["teams"] = t.clone();
                }
                match b.get("off") {
                    Some(Value::Bool(true)) => {
                        p["off"] = json!(true);
                    }
                    Some(Value::Bool(false)) => {
                        p.as_object_mut().unwrap().remove("off");
                    }
                    _ => {}
                }
                let p = p.clone();
                if b.get("off") == Some(&json!(true)) {
                    let id = p["id"].as_str().unwrap_or("").to_string();
                    self.invites.retain(|(person, _)| *person != id);
                }
                self.logged(&who, "changed a person");
                Ok(json!({"person": p}))
            }
            ("POST", "/api/people/invite") => {
                let who = self.need("admin")?;
                let id = b["id"].as_str().unwrap_or("").to_string();
                self.logged(&who, "made an invite");
                Ok(self.invite(&id))
            }
            ("POST", "/api/people/uninvite") => {
                self.need("admin")?;
                let id = b["id"].as_str().unwrap_or("").to_string();
                let before = self.invites.len();
                self.invites.retain(|(person, _)| *person != id);
                Ok(json!({"dropped": before - self.invites.len()}))
            }
            ("POST", "/api/people/remove") => {
                let who = self.need("admin")?;
                self.people.retain(|p| p["id"] != b["id"]);
                self.logged(&who, "removed a person");
                Ok(json!({"ok": true}))
            }
            ("GET", "/api/people/activity") => {
                self.need("admin")?;
                Ok(json!({"lines": self.log}))
            }
            _ => refused("not found", 404),
        }
    }

    /// what `canopy auth join <code>` does here: the invite is used up and
    /// the caller is the person it was for
    fn join(&mut self, code: &str) -> bool {
        let Some(i) = self.invites.iter().position(|(_, c)| c == code) else {
            return false;
        };
        let (person, _) = self.invites.remove(i);
        self.who = Some(person);
        true
    }
}

/// One run of `canopy people <args>` against the fake: what it printed, or
/// its failure, as the TypeScript's `out` reads them both.
async fn run(b: &Mutex<Backend>, args: &[&str]) -> (i32, String) {
    let fake = Fake(|_: &Target, m: &str, p: &str, body: Option<&Value>| {
        b.lock().unwrap().answer(m, p, body)
    });
    let mut out = Out::default();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    match people_cmd(args, &caller(), &fake, &mut out).await {
        Ok(()) => (0, out.text),
        Err(e) => (1, format!("{}{e}\n", out.text)),
    }
}

fn code_in(out: &str) -> String {
    out.split("canopy auth join ")
        .nth(1)
        .and_then(|r| r.split(' ').next())
        .unwrap_or("")
        .to_string()
}

#[tokio::test]
async fn the_owner_adds_a_person_who_joins_with_the_invite_and_holds_a_members_rights() {
    let b = Mutex::new(Backend {
        owner_name: "owner".into(),
        who: Some("owner".into()),
        ..Default::default()
    });
    let (code, out) = run(&b, &["me", "--name", "Eric"]).await;
    assert_eq!(code, 0);
    assert!(out.contains("you are Eric (owner)"), "{out}");

    let (code, out) = run(&b, &["teams", "add", "Rio", "--folder", "/srv/root"]).await;
    assert_eq!(code, 0);
    assert_eq!(out, "made Rio (t-aaaaaaa1): /srv/root\n");

    let (code, out) = run(
        &b,
        &["add", "Avery", "--team", "rio", "--backend", "http://b:1"],
    )
    .await;
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("as member"), "{out}");
    let invite = code_in(&out);
    assert!(invite.starts_with("cnv_"), "{out}");
    assert!(out.contains(&format!("http://b:1/?join={invite}")), "{out}");
    assert!(
        out.starts_with("added Avery (p-aaaaaaa1) as member\ninvite for Avery, good once until ")
    );
    // the add named the team by its id and asked for an invite
    let added = b
        .lock()
        .unwrap()
        .seen
        .iter()
        .rev()
        .find(|s| s.1 == "/api/people/add")
        .cloned()
        .unwrap();
    assert_eq!(
        added.2.unwrap(),
        json!({"name": "Avery", "role": "member", "teams": ["t-aaaaaaa1"], "invite": true})
    );

    assert!(b.lock().unwrap().join(&invite));
    assert!(!b.lock().unwrap().join(&invite), "an invite is good once");

    let (_, me) = run(&b, &["me"]).await;
    assert!(me.contains("Avery"), "{me}");
    assert!(
        me.contains("member; this token holds read, plan, operate"),
        "{me}"
    );

    let (code, refused) = run(&b, &["add", "Friend"]).await;
    assert_eq!(code, 1);
    assert!(refused.contains("your role"), "{refused}");

    let (_, list) = run(&b, &[]).await;
    assert!(list.contains("Eric"), "{list}");
    assert!(list.contains("p-aaaaaaa1  Avery  member  Rio"), "{list}");
    b.lock().unwrap().who = Some("owner".into());
    let (_, teams) = run(&b, &["teams"]).await;
    assert!(teams.contains("Rio   Avery"), "{teams}");
}

#[tokio::test]
async fn a_role_change_an_off_and_a_remove_each_land_and_the_log_names_who_did_them() {
    let b = Mutex::new(Backend {
        owner_name: "Eric".into(),
        who: Some("owner".into()),
        ..Default::default()
    });
    run(&b, &["teams", "add", "Rio"]).await;
    run(&b, &["add", "Avery", "--team", "Rio", "--no-invite"]).await;
    let avery = "p-aaaaaaa1";

    assert!(
        run(&b, &["role", "avery", "viewer"])
            .await
            .1
            .contains("Avery: viewer")
    );
    b.lock().unwrap().who = Some(avery.into());
    assert!(
        run(&b, &["me"])
            .await
            .1
            .contains("viewer; this token holds read")
    );
    b.lock().unwrap().who = Some("owner".into());
    assert_eq!(
        run(&b, &["role", "avery", "boss"]).await,
        (1, "a role is one of owner, admin, member, viewer\n".into())
    );
    assert_eq!(
        run(&b, &["team", "avery", "none"]).await.1.trim(),
        "Avery: viewer"
    );
    assert_eq!(
        run(&b, &["nobody-here"]).await,
        (1, format!("{}\n", people_usage()))
    );
    assert!(
        run(&b, &["role", "nobody", "viewer"])
            .await
            .1
            .contains("nobody here is called nobody")
    );

    let (_, off) = run(&b, &["off", "Avery"]).await;
    assert!(off.contains("Avery is off"), "{off}");
    b.lock().unwrap().who = Some(avery.into());
    assert_eq!(run(&b, &[]).await.0, 1);
    b.lock().unwrap().who = Some("owner".into());

    let (_, log) = run(&b, &["activity", "--limit", "20"]).await;
    assert!(log.contains("Eric  added a person  (cli)"), "{log}");
    assert!(log.contains("Eric  changed a person  (cli)"), "{log}");
    let asked = b
        .lock()
        .unwrap()
        .seen
        .iter()
        .rev()
        .find(|s| s.1.starts_with("/api/people/activity"))
        .cloned()
        .unwrap();
    assert_eq!(asked.1, "/api/people/activity?limit=20");

    assert_eq!(run(&b, &["on", "avery"]).await.0, 0);
    let (_, again) = run(&b, &["invite", "avery", "--hours", "1"]).await;
    let invite = code_in(&again);
    let sent = b
        .lock()
        .unwrap()
        .seen
        .iter()
        .rev()
        .find(|s| s.1 == "/api/people/invite")
        .cloned()
        .unwrap();
    assert_eq!(sent.2.unwrap(), json!({"id": avery, "hours": 1}));
    assert!(b.lock().unwrap().join(&invite));
    b.lock().unwrap().who = Some("owner".into());
    assert!(
        run(&b, &["uninvite", "avery"])
            .await
            .1
            .contains("dropped 0 invites")
    );
    assert!(
        run(&b, &["remove", "avery"])
            .await
            .1
            .contains("removed Avery")
    );
    assert!(!run(&b, &[]).await.1.contains("Avery"));
    assert!(
        run(&b, &["teams", "remove", "rio"])
            .await
            .1
            .contains("removed Rio")
    );
}

#[tokio::test]
async fn usages_and_refusals_come_before_or_after_the_roster_as_the_typescript_has_them() {
    let b = Mutex::new(Backend {
        owner_name: "Eric".into(),
        who: Some("owner".into()),
        ..Default::default()
    });
    let usage = format!("{}\n", people_usage());
    assert_eq!(run(&b, &["add"]).await, (1, usage.clone()));
    assert_eq!(
        run(&b, &["add", "x", "--role", "boss"]).await,
        (1, "--role is one of owner, admin, member, viewer\n".into())
    );
    assert_eq!(
        run(&b, &["add", "x", "--hours", "0"]).await,
        (1, "--hours is a number of hours, from 1 to 720\n".into())
    );
    assert_eq!(run(&b, &["invite", "a", "b"]).await, (1, usage.clone()));
    assert_eq!(run(&b, &["me", "extra"]).await, (1, usage.clone()));
    assert_eq!(run(&b, &["teams", "what"]).await, (1, usage.clone()));
    assert_eq!(run(&b, &["activity", "x"]).await, (1, usage.clone()));
    assert_eq!(run(&b, &["teams"]).await, (0, "no teams\n".into()));
    assert_eq!(run(&b, &["activity"]).await, (0, "nothing yet\n".into()));
    assert_eq!(
        run(&b, &["add", "x", "--team", "nope"]).await,
        (1, "no team nope\n".into())
    );
    assert_eq!(
        run(&b, &["list", "--backend", "http://x/y"]).await,
        (
            1,
            "--backend must be an http(s) origin, got http://x/y\n".into()
        )
    );
    // nothing asked before those, and the roster before a missing person
    b.lock().unwrap().seen.clear();
    assert_eq!(run(&b, &["invite"]).await, (1, usage.clone()));
    assert_eq!(b.lock().unwrap().seen.len(), 1);
    run(&b, &["teams", "add", "Rio"]).await;
    assert_eq!(run(&b, &["teams", "set", "rio"]).await, (1, usage));
    assert_eq!(
        run(
            &b,
            &["teams", "set", "rio", "--name", "Rio2", "--folder", "/a"]
        )
        .await,
        (0, "Rio2 (t-aaaaaaa1): /a\n".into())
    );
    b.lock().unwrap().who = None;
    assert_eq!(
        run(&b, &["me"]).await,
        (
            1,
            "nobody is signed in here; run canopy auth login, or canopy auth join <code>\n".into()
        )
    );
}

#[test]
fn numbers_read_as_javascripts_number_reads_them() {
    assert_eq!(js_to_number(" 5 "), 5.0);
    assert_eq!(js_to_number("0x10"), 16.0);
    assert_eq!(js_to_number("1e1"), 10.0);
    assert_eq!(js_to_number(".5"), 0.5);
    assert_eq!(js_to_number("5."), 5.0);
    assert_eq!(js_to_number(""), 0.0);
    assert!(js_to_number("-0x1").is_nan());
    assert_eq!(js_to_number("Infinity"), f64::INFINITY);
    assert!(js_to_number("inf").is_nan());
    assert!(js_to_number("1_0").is_nan());
    assert_eq!(js_to_number("0b11"), 3.0);
    assert_eq!(js_to_number("+.5e1"), 5.0);
}
