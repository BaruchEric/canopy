//! `GET /api/auth` and the `/api/auth/*` routes (port of `authInfo` and
//! `authRoute` in `src/server/callers.ts`). What they ask of the people on a
//! backend goes through the `AuthPeople` trait, so this crate needs nothing
//! of the server's people hub.

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::book::{Caller, Claim, PendingPair, Renew, Ticketed};
use crate::gate::{CallerGate, CallersMode, RefusedLog, Reply, is_auth, refusal};
use crate::people::{Me, invite_code};
use crate::request::Req;
use crate::rights::{CallerKind, PAIR_KINDS, PairKind, Right, allows};
use crate::text::utf16_prefix;

/// What the auth routes ask of the people on this backend (server/people.ts).
pub trait AuthPeople {
    /// who a caller is to the page: None for nobody known under enforce
    fn me(&self, caller: Option<&Caller>, mode: CallersMode) -> Option<Me>;
    /// the id of the person a caller is; the owner's for one with no user
    fn id_of(&self, caller: Option<&Caller>) -> String;
    /// why `actor` may not give a device to `person`, or None
    fn hand_refusal(&self, actor: Option<&Caller>, person: &str) -> Option<String>;
    /// an invite spent: its person, or None for a wrong, used or expired code
    fn redeem(&self, code: &str) -> Option<Invited>;
    /// the folders a caller's person is held to, or None for the whole backend
    fn scope_of(&self, caller: Option<&Caller>) -> Option<Vec<String>>;
}

/// The person an invite was for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invited {
    pub person: String,
    pub name: String,
}

/// What `GET /api/auth` answers, in the TS's key order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AuthInfo {
    pub mode: CallersMode,
    pub refused: RefusedLog,
    pub callers: Vec<Caller>,
    pub pending: Vec<PendingPair>,
    pub you: CallerKind,
    #[serde(rename = "youId")]
    pub you_id: Option<String>,
    pub person: Option<Me>,
    pub rights: Vec<Right>,
    pub scope: Option<Vec<String>>,
}

/// Everyone learns the mode, who they are and how many calls were refused,
/// which is all a sign-in needs. The callers, the waiting pairs and the
/// refused calls themselves name devices, addresses and routes, so they go to
/// a caller that holds `admin` and stay empty for the rest. While nothing is
/// enforced the whole answer goes to anyone, unless the caller is scoped.
pub fn auth_info(
    gate: &CallerGate,
    caller: Option<&Caller>,
    people: Option<&dyn AuthPeople>,
) -> AuthInfo {
    // the folders a member or viewer on a walled team is held to (FR-074,
    // plan 2); someone scoped never reads the callers, whatever the mode
    let scope = people.and_then(|p| p.scope_of(caller));
    let whole =
        (gate.mode != CallersMode::Enforce && scope.is_none()) || gate.can(caller, Right::Admin);
    let refused = gate.refused();
    AuthInfo {
        mode: gate.mode,
        refused: if whole {
            refused
        } else {
            RefusedLog {
                count: refused.count,
                recent: Vec::new(),
            }
        },
        callers: if whole { gate.book.list() } else { Vec::new() },
        pending: if whole {
            gate.book.pending()
        } else {
            Vec::new()
        },
        you: caller.map_or(CallerKind::None, |c| c.kind),
        you_id: caller.map(|c| c.id.clone()),
        // with no token outside enforce, the owner, as every route there takes
        // nobody for a person
        person: people.and_then(|p| p.me(caller, gate.mode)),
        rights: gate.rights(caller),
        scope,
    }
}

/// `b[k]` when it is a string that is not empty.
fn field<'a>(b: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    b.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn ticket_right(v: Option<&Value>) -> Option<Ticketed> {
    match v.and_then(Value::as_str) {
        Some("term") => Some(Ticketed::Shell),
        Some("helper") => Some(Ticketed::Helper),
        Some("events") => Some(Ticketed::Read),
        _ => None,
    }
}

/// `await req.json().catch(() => null)`, kept when it is an object: the body
/// decoded as UTF-8 the way a fetch body's text is, a leading BOM dropped.
fn body_object(body: &[u8]) -> Map<String, Value> {
    let text = String::from_utf8_lossy(body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `/api/auth` and below, after the gate has passed the request; None for any
/// other path. `body` is the request's raw body. `addr` is the client's
/// address, which a pair request shows and the guess limit counts by.
pub fn auth_route(
    gate: &CallerGate,
    req: &Req,
    body: &[u8],
    caller: Option<&Caller>,
    addr: &str,
    people: Option<&dyn AuthPeople>,
) -> Option<Reply> {
    let path = req.path();
    if !is_auth(path) {
        return None;
    }
    let book = &gate.book;
    if path == "/api/auth" {
        if req.method() != "GET" {
            return Some(Reply::error(405, "/api/auth only answers a GET"));
        }
        let info = auth_info(gate, caller, people);
        return Some(Reply::json(
            200,
            serde_json::to_value(info).unwrap_or(Value::Null),
        ));
    }
    if req.method() != "POST" {
        return Some(Reply::error(405, "the auth routes take a POST"));
    }
    let b = body_object(body);
    let route = &path["/api/auth/".len()..];
    let too_many = || {
        Reply::error(
            429,
            "too many wrong tries from this address; try again in ten minutes",
        )
    };
    let ok = || Reply::json(200, json!({ "ok": true }));
    let reply = match route {
        "pair" => {
            let Some(label) = field(&b, "label") else {
                return Some(Reply::error(400, "a pair request needs a label"));
            };
            let kind = match b.get("kind") {
                None => None,
                Some(v) => match v.as_str().and_then(PairKind::parse) {
                    Some(k) => Some(k),
                    None => {
                        let all: Vec<&str> = PAIR_KINDS.iter().map(|k| k.as_str()).collect();
                        return Some(Reply::error(
                            400,
                            format!("kind is one of {}", all.join(", ")),
                        ));
                    }
                },
            };
            let renew = match (field(&b, "id"), field(&b, "secret")) {
                (Some(id), Some(secret)) => Some(Renew {
                    id: id.to_string(),
                    secret: secret.to_string(),
                }),
                _ => None,
            };
            match book.pair(label, addr, kind, renew.as_ref()) {
                Err(error) => Reply::error(429, error),
                Ok(got) => {
                    gate.pairs_changed();
                    gate.announce();
                    Reply::json(200, serde_json::to_value(got).unwrap_or(Value::Null))
                }
            }
        }
        "claim" => {
            if gate.locked(route, addr) {
                return Some(too_many());
            }
            let (Some(id), Some(secret)) = (field(&b, "id"), field(&b, "secret")) else {
                return Some(Reply::error(400, "id and secret are required"));
            };
            let guess = book.wrong_secret(id, secret);
            match book.claim(id, secret) {
                Some(Claim::Waiting) => Reply::json(200, json!({ "waiting": true })),
                None => {
                    if guess {
                        gate.missed(route, addr);
                    }
                    if book.replaced(id, secret) {
                        Reply::error(
                            404,
                            "this request was replaced by a newer one from the same asker",
                        )
                    } else {
                        Reply::error(
                            404,
                            "no such pair request: it was denied, claimed, or has expired",
                        )
                    }
                }
                Some(Claim::Token(token)) => {
                    gate.announce();
                    Reply::json(200, json!({ "token": token }))
                }
            }
        }
        "first" => {
            if gate.locked(route, addr) {
                return Some(too_many());
            }
            let (Some(id), Some(given)) = (field(&b, "id"), field(&b, "code")) else {
                return Some(Reply::error(400, "id and code are required"));
            };
            let given = crate::text::js_trim(given).to_uppercase();
            if !gate.use_first(&given, id) {
                gate.missed(route, addr);
                return Some(Reply::error(
                    403,
                    "that is not the first sign-in code, or the pair request is not waiting",
                ));
            }
            gate.pairs_changed();
            ok()
        }
        "approve" | "deny" => {
            let Some(id) = field(&b, "id") else {
                return Some(Reply::error(400, "id is required"));
            };
            // the device is its approver's own unless the approval names
            // someone the approver may sign in (FR-074)
            let person = match (route, people) {
                ("approve", Some(p)) => {
                    Some(field(&b, "person").map_or_else(|| p.id_of(caller), str::to_string))
                }
                _ => None,
            };
            if let (Some(person), Some(p)) = (&person, people)
                && let Some(why) = p.hand_refusal(caller, person)
            {
                return Some(Reply::error(403, why));
            }
            let done = if route == "approve" {
                book.approve(id, person.as_deref())
            } else {
                book.deny(id)
            };
            if !done {
                return Some(Reply::error(404, "no such pair request waiting"));
            }
            gate.pairs_changed();
            ok()
        }
        "join" => {
            // an invite traded for a session of its person's (FR-074)
            let Some(people) = people else {
                return Some(Reply::error(404, "this backend keeps no people"));
            };
            if gate.locked(route, addr) {
                return Some(too_many());
            }
            let code = invite_code(field(&b, "code").unwrap_or(""));
            let label = field(&b, "label");
            let kind = match b.get("kind") {
                Some(Value::String(k)) if k == "cli" => Some(CallerKind::Cli),
                None => Some(CallerKind::Page),
                Some(Value::String(k)) if k == "page" => Some(CallerKind::Page),
                _ => None,
            };
            let Some(label) = label else {
                return Some(Reply::error(400, "a join needs a label"));
            };
            let Some(kind) = kind else {
                return Some(Reply::error(400, "kind is page or cli"));
            };
            let Some(got) = code.and_then(|c| people.redeem(&c)) else {
                gate.missed(route, addr);
                return Some(Reply::error(
                    403,
                    "that invite is not one: it was used, has expired, or was typed wrong",
                ));
            };
            let minted = book.mint(
                kind,
                crate::book::MintOpts::label(utf16_prefix(label, 80)).user(got.person),
            );
            // the pair this asker was waiting on is not needed any more
            if let (Some(id), Some(secret)) = (field(&b, "id"), field(&b, "secret"))
                && book.withdraw(id, secret)
            {
                gate.pairs_changed();
            }
            gate.announce();
            Reply::json(200, json!({ "token": minted.token, "person": got.name }))
        }
        "signout" => {
            // a session ends itself, whatever its role: revoke is admin's
            let Some(caller) = caller else {
                return Some(Reply::error(401, "no session to sign out"));
            };
            if !matches!(
                caller.kind,
                CallerKind::Page | CallerKind::Cli | CallerKind::Helper
            ) {
                return Some(Reply::error(
                    403,
                    "only a page, a CLI or a helper signs itself out",
                ));
            }
            let _ = book.revoke(&caller.id);
            gate.announce();
            ok()
        }
        "revoke" => {
            let Some(id) = field(&b, "id") else {
                return Some(Reply::error(400, "id is required"));
            };
            match book.revoke(id) {
                Err(err) => {
                    gate.announce();
                    Reply::error(
                        500,
                        format!(
                            "revoked until canopy restarts, but callers.json could not be written ({err})"
                        ),
                    )
                }
                Ok(false) => Reply::error(404, "no such caller"),
                Ok(true) => {
                    gate.announce();
                    ok()
                }
            }
        }
        "ticket" => {
            let Some(right) = ticket_right(b.get("for")) else {
                return Some(Reply::error(
                    400,
                    "for is \"term\", \"helper\" or \"events\"",
                ));
            };
            let need = right.right();
            match caller {
                Some(c) if gate.can(Some(c), need) => match book.ticket(&c.id, right) {
                    Ok(ticket) => Reply::json(200, json!({ "ticket": ticket })),
                    // revoked since the check
                    Err(_) => refusal(need, false, false),
                },
                _ => refusal(
                    need,
                    caller.is_some(),
                    caller.is_some_and(|c| allows(c.kind, need)),
                ),
            }
        }
        _ => Reply::error(404, format!("no such auth route: {route}")),
    };
    Some(reply)
}
