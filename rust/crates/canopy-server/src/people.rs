//! The people on a backend, read side only (`src/core/people.ts` and the
//! hub in `src/server/people.ts`): `people.json` parsed record by record,
//! who a caller is, the folders their teams hold them to, and
//! `GET /api/people`. Every change to the roster (add, set, remove, teams,
//! invites, an invite spent by a join) is not ported yet.

use canopy_auth::people::{Me, Role, role_allows};
use canopy_auth::rights::Right;
use canopy_auth::{AuthPeople, Caller, CallersMode, Invited};
use canopy_core::pathx::{js_trim, js_ws};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::SystemTime;

pub const OWNER_ID: &str = "owner";
const NAME_MAX: usize = 40;

#[derive(Debug, Clone, PartialEq)]
pub struct Person {
    pub id: String,
    pub name: String,
    pub role: Role,
    pub teams: Vec<String>,
    pub created: Value,
    pub color: Option<u64>,
    pub off: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Team {
    pub id: String,
    pub name: String,
    pub folders: Vec<String>,
    pub created: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Invite {
    pub hash: String,
    pub person: String,
    pub created: Value,
    pub expires: f64,
    pub expires_raw: Value,
    pub by: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PeopleFile {
    pub owner_name: String,
    pub owner_color: Option<u64>,
    pub people: Vec<Person>,
    pub teams: Vec<Team>,
    pub invites: Vec<Invite>,
}

/// A name as kept: runs of whitespace and control characters as one space,
/// trimmed, at most `NAME_MAX` UTF-16 units, trimmed again.
pub fn clean_name(raw: &str) -> String {
    let mut one = String::with_capacity(raw.len());
    let mut gap = false;
    for c in raw.chars() {
        if js_ws(c) || (c as u32) <= 0x1f || c == '\u{7f}' {
            if !gap {
                one.push(' ');
            }
            gap = true;
        } else {
            one.push(c);
            gap = false;
        }
    }
    let trimmed = js_trim(&one);
    let units: Vec<u16> = trimmed.encode_utf16().take(NAME_MAX).collect();
    js_trim(&String::from_utf16_lossy(&units)).to_string()
}

/// A folder as kept: an absolute path or an ssh locator with no trailing
/// slash, or None when it is neither.
pub fn clean_folder(raw: &str) -> Option<String> {
    let f = js_trim(raw);
    if !f.starts_with('/') && !f.starts_with("ssh://") {
        return None;
    }
    let cut = if f.len() > 1 {
        f.trim_end_matches('/')
    } else {
        f
    };
    Some(if cut.is_empty() {
        "/".into()
    } else {
        cut.into()
    })
}

fn id_of_kind(v: &str, prefix: &str) -> bool {
    v.strip_prefix(prefix)
        .is_some_and(|b| b.len() == 8 && b.bytes().all(|c| matches!(c, b'a'..=b'z' | b'2'..=b'7')))
}

/// a time that is a number at or past zero
fn time_of(v: Option<&Value>) -> Option<Value> {
    v.filter(|v| v.as_f64().is_some_and(|n| n >= 0.0)).cloned()
}

/// an integer hue, 0 to 359
fn hue(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_f64)
        .filter(|n| n.fract() == 0.0 && (0.0..360.0).contains(n))
        .map(|n| n as u64)
}

fn strings(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect()
}

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// The file read back: a record that does not check out is dropped, never
/// the file; a second record with an id or a name already taken too.
pub fn parse_people(v: &Value) -> PeopleFile {
    let empty = Map::new();
    let Some(v) = v.as_object() else {
        return PeopleFile {
            owner_name: "owner".into(),
            owner_color: None,
            people: vec![],
            teams: vec![],
            invites: vec![],
        };
    };
    let o = v.get("owner").and_then(Value::as_object).unwrap_or(&empty);
    let owner_name = o
        .get("name")
        .and_then(Value::as_str)
        .map(clean_name)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "owner".into());
    let owner_color = hue(o.get("color"));
    let list = |k: &str| {
        v.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut teams: Vec<Team> = vec![];
    for t in list("teams") {
        let (Some(id), Some(name)) = (
            t.get("id").and_then(Value::as_str),
            t.get("name").and_then(Value::as_str),
        ) else {
            continue;
        };
        if !id_of_kind(id, "t-") {
            continue;
        }
        let name = clean_name(name);
        if name.is_empty()
            || teams
                .iter()
                .any(|x| x.id == id || same_name(&x.name, &name))
        {
            continue;
        }
        teams.push(Team {
            id: id.into(),
            name,
            folders: strings(t.get("folders"))
                .iter()
                .filter_map(|f| clean_folder(f))
                .collect(),
            created: time_of(t.get("created")).unwrap_or(json!(0)),
        });
    }
    let mut people: Vec<Person> = vec![];
    for p in list("people") {
        let (Some(id), Some(name), Some(role)) = (
            p.get("id").and_then(Value::as_str),
            p.get("name").and_then(Value::as_str),
            p.get("role").and_then(Value::as_str).and_then(Role::parse),
        ) else {
            continue;
        };
        if !id_of_kind(id, "p-") {
            continue;
        }
        let name = clean_name(name);
        if name.is_empty()
            || same_name(&name, &owner_name)
            || people
                .iter()
                .any(|x| x.id == id || same_name(&x.name, &name))
        {
            continue;
        }
        people.push(Person {
            id: id.into(),
            name,
            role,
            teams: strings(p.get("teams"))
                .into_iter()
                .filter(|id| teams.iter().any(|t| &t.id == id))
                .collect(),
            created: time_of(p.get("created")).unwrap_or(json!(0)),
            color: hue(p.get("color")),
            off: p.get("off") == Some(&Value::Bool(true)),
        });
    }
    let mut invites: Vec<Invite> = vec![];
    for i in list("invites") {
        let (Some(hash), Some(person)) = (
            i.get("hash").and_then(Value::as_str),
            i.get("person").and_then(Value::as_str),
        ) else {
            continue;
        };
        if hash.len() != 64 || !hash.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
            continue;
        }
        let (Some(created), Some(expires)) = (time_of(i.get("created")), time_of(i.get("expires")))
        else {
            continue;
        };
        if person != OWNER_ID && !people.iter().any(|p| p.id == person) {
            continue;
        }
        invites.push(Invite {
            hash: hash.into(),
            person: person.into(),
            created,
            expires: expires.as_f64().unwrap_or(0.0),
            expires_raw: expires,
            by: i
                .get("by")
                .and_then(Value::as_str)
                .unwrap_or(OWNER_ID)
                .into(),
        });
    }
    PeopleFile {
        owner_name,
        owner_color,
        people,
        teams,
        invites,
    }
}

impl PeopleFile {
    pub fn owner(&self) -> Person {
        Person {
            id: OWNER_ID.into(),
            name: self.owner_name.clone(),
            role: Role::Owner,
            teams: vec![],
            created: json!(0),
            color: self.owner_color,
            off: false,
        }
    }

    /// everyone, the owner first
    pub fn everyone(&self) -> Vec<Person> {
        let mut all = vec![self.owner()];
        all.extend(self.people.iter().cloned());
        all
    }

    pub fn by_id(&self, id: &str) -> Option<Person> {
        if id == OWNER_ID {
            Some(self.owner())
        } else {
            self.people.iter().find(|p| p.id == id).cloned()
        }
    }

    /// The person a session with this `user` is: the owner for one from
    /// before there were people, None for one whose person is gone or off.
    pub fn person_of(&self, user: Option<&str>) -> Option<Person> {
        self.by_id(user.unwrap_or(OWNER_ID)).filter(|p| !p.off)
    }

    /// The folders a person is held to: None for an owner, an admin, and
    /// anyone whose teams name no folder (`scopeOf` in core/scope.ts).
    pub fn scope_of(&self, p: &Person) -> Option<Vec<String>> {
        if matches!(p.role, Role::Owner | Role::Admin) {
            return None;
        }
        let mut out: Vec<String> = vec![];
        for t in self.teams.iter().filter(|t| p.teams.contains(&t.id)) {
            for f in &t.folders {
                if !out.contains(f) {
                    out.push(f.clone());
                }
            }
        }
        (!out.is_empty()).then_some(out)
    }

    pub fn live_invites(&self, now: f64) -> Vec<&Invite> {
        self.invites.iter().filter(|i| i.expires > now).collect()
    }
}

impl Person {
    /// the person as the file and the API keep one
    pub fn to_json(&self) -> Map<String, Value> {
        let mut o = Map::new();
        o.insert("id".into(), json!(self.id));
        o.insert("name".into(), json!(self.name));
        o.insert("role".into(), json!(self.role.as_str()));
        o.insert("teams".into(), json!(self.teams));
        o.insert("created".into(), self.created.clone());
        if let Some(c) = self.color {
            o.insert("color".into(), json!(c));
        }
        if self.off {
            o.insert("off".into(), json!(true));
        }
        o
    }
}

const RANK: fn(Role) -> u8 = |r| match r {
    Role::Viewer => 0,
    Role::Member => 1,
    Role::Admin => 2,
    Role::Owner => 3,
};

fn may_grant(actor: Role, target: Role) -> bool {
    role_allows(actor, Right::Admin) && RANK(actor) >= RANK(target)
}

/// why `actor` may not sign `target` in, or None
pub fn hand_refusal(actor: &Person, target: &Person) -> Option<String> {
    if target.off {
        return Some(format!("{} is turned off", target.name));
    }
    if !role_allows(actor.role, Right::Admin) {
        return Some("handing out a sign-in takes the admin right".into());
    }
    if target.id != actor.id && !may_grant(actor.role, target.role) {
        return Some(format!("only an owner signs {} in", target.name));
    }
    None
}

/// The roster on disk, read again when the file's mtime moves. A file that
/// cannot be read keeps the roster last read; only a missing one is nobody
/// but the owner.
pub struct People {
    dir: String,
    kept: Mutex<(Option<SystemTime>, PeopleFile)>,
    /// the repos each browser has open, by its id, as its person said
    places: Mutex<HashMap<String, Place>>,
}

/// how long a place outlives its browser's stream, so a place said just
/// before the stream opened is not lost
const PLACE_WAITS: f64 = 30_000.0;
/// the places kept at most, so a caller cannot grow the map without end
const MOST_BROWSERS: usize = 500;
/// the repos one place names at most (`MOST_PLACES`)
const MOST_PLACES: usize = 12;

#[derive(Debug, Clone, PartialEq)]
struct Place {
    person: String,
    repos: Vec<String>,
    said: f64,
}

/// `parsePlaces()`: repo ids, each once, at most MOST_PLACES; None when the
/// list is not one.
pub fn parse_places(v: &Value) -> Option<Vec<String>> {
    let mut out: Vec<String> = vec![];
    for x in v.as_array()? {
        let s = x
            .as_str()
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200)?;
        if !out.iter().any(|o| o == s) {
            out.push(s.to_string());
        }
        if out.len() == MOST_PLACES {
            break;
        }
    }
    Some(out)
}

/// What `POST /api/people/at` answers: its status and body, and whether
/// the people list moved for every page.
pub struct PlaceReply {
    pub status: u16,
    pub body: Value,
    pub publish: bool,
}

impl People {
    pub fn new(dir: &str) -> People {
        People {
            dir: dir.into(),
            kept: Mutex::new((None, parse_people(&Value::Null))),
            places: Mutex::new(HashMap::new()),
        }
    }

    fn path(&self) -> String {
        canopy_core::pathx::join(&self.dir, "people.json")
    }

    pub fn file(&self) -> PeopleFile {
        let mut kept = self.kept.lock().unwrap_or_else(|e| e.into_inner());
        let path = self.path();
        let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if mtime.is_some() && mtime == kept.0 {
            return kept.1.clone();
        }
        match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(v) => *kept = (mtime, parse_people(&v)),
                Err(e) => eprintln!(
                    "people: {path} could not be read ({e}); keeping the roster last read"
                ),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                *kept = (None, parse_people(&Value::Null));
            }
            Err(e) => {
                eprintln!("people: {path} could not be read ({e}); keeping the roster last read")
            }
        }
        kept.1.clone()
    }

    /// `info()`: every person with the browsers they have on and the repos
    /// those have open, and the teams. `devices` is the devices list now.
    pub fn here(&self, devices: &[Value], now: f64) -> Value {
        let file = self.file();
        let live = file.live_invites(now);
        let places = self.places.lock().unwrap_or_else(|e| e.into_inner());
        let people: Vec<Value> = file
            .everyone()
            .iter()
            .map(|p| {
                let mine: Vec<&Value> = devices
                    .iter()
                    .filter(|d| d.get("person").and_then(Value::as_str).unwrap_or(OWNER_ID) == p.id)
                    .collect();
                let mut at: Vec<&str> = vec![];
                for d in &mine {
                    let id = d["id"].as_str().unwrap_or_default();
                    // a place counts only for the person who said it
                    if let Some(place) = places.get(id).filter(|pl| pl.person == p.id) {
                        for r in &place.repos {
                            if !at.contains(&r.as_str()) {
                                at.push(r);
                            }
                        }
                    }
                }
                let shown: Vec<Value> = mine
                    .iter()
                    .map(|d| json!({ "id": d["id"], "name": d["name"], "platform": d["platform"] }))
                    .collect();
                let mut o = p.to_json();
                o.insert("devices".into(), json!(shown));
                o.insert("at".into(), json!(at));
                o.insert(
                    "invited".into(),
                    json!(live.iter().filter(|i| i.person == p.id).count()),
                );
                Value::Object(o)
            })
            .collect();
        let teams: Vec<Value> = file
            .teams
            .iter()
            .map(|t| json!({ "id": t.id, "name": t.name, "folders": t.folders, "created": t.created }))
            .collect();
        json!({ "people": people, "teams": teams })
    }

    /// `sawDevices()`: the devices list moved, so a place whose browser is
    /// gone and was said long enough ago is forgotten.
    pub fn saw_devices(&self, devices: &[Value], now: f64) {
        let on: Vec<&str> = devices.iter().filter_map(|d| d["id"].as_str()).collect();
        self.places
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|id, place| on.contains(&id.as_str()) || now - place.said <= PLACE_WAITS);
    }

    /// `POST /api/people/at`: the repos a browser has open, said by its own
    /// person. One not on yet is taken at its word, and shown only once its
    /// stream says the same person.
    pub fn at(
        &self,
        caller: Option<&Caller>,
        body: &Value,
        devices: &[Value],
        now: f64,
    ) -> PlaceReply {
        let reply = |status: u16, body: Value, publish: bool| PlaceReply {
            status,
            body,
            publish,
        };
        let ok = || json!({ "ok": true });
        let file = self.file();
        let Some(actor) = file.person_of(caller.and_then(|c| c.user.as_deref())) else {
            return reply(
                401,
                json!({ "error": "nobody this backend knows is calling" }),
                false,
            );
        };
        let client = body
            .get("client")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let repos = body.get("repos").and_then(parse_places);
        let is_client = client.len() == 16
            && client
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        let Some(repos) = repos.filter(|_| is_client) else {
            let error = "client is a browser's id and repos a list of repo ids";
            return reply(400, json!({ "error": error }), false);
        };
        let device = devices.iter().find(|d| d["id"] == client);
        if device.is_some_and(|d| {
            d.get("person").and_then(Value::as_str).unwrap_or(OWNER_ID) != actor.id
        }) {
            return reply(200, ok(), false);
        }
        let mut places = self.places.lock().unwrap_or_else(|e| e.into_inner());
        let was = places.get(client).cloned();
        if was
            .as_ref()
            .is_some_and(|w| w.person == actor.id && w.repos == repos)
        {
            return reply(200, ok(), false);
        }
        if repos.is_empty() {
            places.remove(client);
        } else if was.is_some() || places.len() < MOST_BROWSERS {
            places.insert(
                client.to_string(),
                Place {
                    person: actor.id.clone(),
                    repos,
                    said: now,
                },
            );
        }
        reply(200, ok(), device.is_some())
    }

    /// `GET /api/people`: who is here, and the live invites for a caller
    /// who holds admin.
    pub fn info(&self, caller: Option<&Caller>, devices: &[Value], now: f64) -> Value {
        let mut out = self.here(devices, now);
        let file = self.file();
        let live = file.live_invites(now);
        let me = file.person_of(caller.and_then(|c| c.user.as_deref()));
        let invites: Vec<Value> = if me.is_some_and(|m| role_allows(m.role, Right::Admin)) {
            live.iter()
                .map(|i| json!({ "person": i.person, "created": i.created, "expires": i.expires_raw, "by": i.by }))
                .collect()
        } else {
            vec![]
        };
        out["invites"] = json!(invites);
        out
    }
}

impl AuthPeople for People {
    fn me(&self, caller: Option<&Caller>, mode: CallersMode) -> Option<Me> {
        if caller.is_none() && mode == CallersMode::Enforce {
            return None;
        }
        let p = self
            .file()
            .person_of(caller.and_then(|c| c.user.as_deref()))?;
        Some(Me {
            id: p.id,
            name: p.name,
            role: p.role,
        })
    }

    fn id_of(&self, caller: Option<&Caller>) -> String {
        caller
            .and_then(|c| c.user.clone())
            .unwrap_or_else(|| OWNER_ID.into())
    }

    fn hand_refusal(&self, actor: Option<&Caller>, person: &str) -> Option<String> {
        let file = self.file();
        let Some(who) = file.person_of(actor.and_then(|c| c.user.as_deref())) else {
            return Some("handing out a sign-in takes the admin right".into());
        };
        let Some(target) = file.by_id(person) else {
            return Some(format!("no person {person}"));
        };
        hand_refusal(&who, &target)
    }

    /// An invite is spent by writing the roster, which this port does not
    /// do yet: the gate answers a join 501 before it gets here.
    fn redeem(&self, _code: &str) -> Option<Invited> {
        None
    }

    fn scope_of(&self, caller: Option<&Caller>) -> Option<Vec<String>> {
        let file = self.file();
        let p = file.person_of(caller.and_then(|c| c.user.as_deref()))?;
        file.scope_of(&p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roster() -> Value {
        json!({
            "owner": { "name": "  Eric\n B ", "color": 30 },
            "teams": [
                { "id": "t-aaaaaaaa", "name": "Shop", "folders": ["/srv/shop/", "relative", "ssh://mini/x/"], "created": 5 },
                { "id": "t-bbbbbbbb", "name": "shop", "folders": [] },
                { "id": "bad", "name": "Bad" }
            ],
            "people": [
                { "id": "p-cccccccc", "name": "Ariel", "role": "member", "teams": ["t-aaaaaaaa", "t-zzzzzzzz"], "created": 9 },
                { "id": "p-dddddddd", "name": "ariel", "role": "viewer" },
                { "id": "p-eeeeeeee", "name": "eric b", "role": "admin" },
                { "id": "p-ffffffff", "name": "Elsa", "role": "admin", "off": true, "color": 400 },
                { "id": "p-gggggggg", "name": "Nobody", "role": "god" }
            ],
            "invites": [
                { "hash": "a".repeat(64), "person": "p-cccccccc", "created": 1, "expires": 100 },
                { "hash": "b".repeat(64), "person": "p-zzzzzzzz", "created": 1, "expires": 100 },
                { "hash": "c".repeat(64), "person": "owner", "created": 1 }
            ]
        })
    }

    #[test]
    fn the_file_drops_bad_records_and_names_already_taken() {
        let f = parse_people(&roster());
        assert_eq!(f.owner_name, "Eric B");
        assert_eq!(f.owner_color, Some(30));
        assert_eq!(f.teams.len(), 1);
        assert_eq!(f.teams[0].folders, ["/srv/shop", "ssh://mini/x"]);
        assert_eq!(
            f.people.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["p-cccccccc", "p-ffffffff"]
        );
        assert_eq!(f.people[0].teams, ["t-aaaaaaaa"]);
        assert_eq!(f.people[1].color, None);
        assert_eq!(f.invites.len(), 1);
        assert_eq!(f.invites[0].by, "owner");
    }

    #[test]
    fn a_member_on_a_team_with_folders_is_scoped_and_an_off_person_is_nobody() {
        let f = parse_people(&roster());
        let ariel = f.person_of(Some("p-cccccccc")).unwrap();
        assert_eq!(
            f.scope_of(&ariel),
            Some(vec!["/srv/shop".into(), "ssh://mini/x".into()])
        );
        assert_eq!(f.scope_of(&f.owner()), None);
        assert!(f.person_of(Some("p-ffffffff")).is_none());
        assert_eq!(f.person_of(None).unwrap().id, "owner");
    }

    #[test]
    fn handing_out_a_sign_in_takes_admin_and_a_rank_at_least_the_targets() {
        let f = parse_people(&roster());
        let ariel = f.by_id("p-cccccccc").unwrap();
        let elsa = f.by_id("p-ffffffff").unwrap();
        assert_eq!(
            hand_refusal(&ariel, &f.owner()).as_deref(),
            Some("handing out a sign-in takes the admin right")
        );
        assert_eq!(
            hand_refusal(&f.owner(), &elsa).as_deref(),
            Some("Elsa is turned off")
        );
        assert_eq!(hand_refusal(&f.owner(), &ariel), None);
    }

    #[test]
    fn info_shows_invites_only_to_an_admin() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("people.json"), roster().to_string()).unwrap();
        let people = People::new(dir.path().to_str().unwrap());
        let owner = people.info(None, &[], 50.0);
        assert_eq!(owner["invites"].as_array().unwrap().len(), 1);
        assert_eq!(owner["people"][1]["invited"], 1);
        assert_eq!(owner["people"][0]["name"], "Eric B");
        let member = Caller {
            id: "x".into(),
            kind: canopy_auth::rights::CallerKind::Page,
            label: "x".into(),
            created: 0,
            used: 0,
            term: None,
            run: None,
            user: Some("p-cccccccc".into()),
        };
        assert!(
            people.info(Some(&member), &[], 50.0)["invites"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            people.info(None, &[], 200.0)["invites"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn a_missing_file_is_the_owner_alone() {
        let dir = tempfile::tempdir().unwrap();
        let people = People::new(dir.path().to_str().unwrap());
        let me = people.me(None, CallersMode::Log).unwrap();
        assert_eq!((me.id.as_str(), me.name.as_str()), ("owner", "owner"));
        assert!(people.me(None, CallersMode::Enforce).is_none());
    }
}
