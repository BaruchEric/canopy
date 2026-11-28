//! People, roles and teams (`src/core/people.ts`): the roles, the one copy
//! every crate uses (canopy-auth adds what each role may do), their words,
//! and finding a person or a team by id or by name in a roster as the API
//! sends it (a people file's shape: `owner`, `people`, `teams`). The rules
//! on who may change whom, the invites and the activity log are the
//! server's (canopy-server's `people.rs` for the reads).

use crate::pathx::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::fmt;

/// `Role`: what a person may do, from all of it to reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Viewer,
}

/// `ROLES`, in that order.
pub const ROLES: [Role; 4] = [Role::Owner, Role::Admin, Role::Member, Role::Viewer];

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Member => "member",
            Role::Viewer => "viewer",
        }
    }

    pub fn parse(s: &str) -> Option<Role> {
        ROLES.into_iter().find(|r| r.as_str() == s)
    }

    /// `ROLE_WORDS[role]`: what the role is, in a line.
    pub fn words(self) -> &'static str {
        match self {
            Role::Owner => "everything, and the only one who makes or changes an owner",
            Role::Admin => "everything but changing an owner: people, sources, the kit, secrets",
            Role::Member => "runs, chats, shells and commits; no settings, people or secrets",
            Role::Viewer => "reads the board; starts and changes nothing",
        }
    }
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `OWNER_ID`: the built-in person, never in the file's list, never
/// removed or demoted.
pub const OWNER_ID: &str = "owner";

/// `isRole()`.
pub fn is_role(v: &str) -> bool {
    Role::parse(v).is_some()
}

/// The role names joined, as `ROLES.join(sep)` prints them.
pub fn role_names(sep: &str) -> String {
    ROLES.map(Role::as_str).join(sep)
}

/// `a.toLowerCase() === b.toLowerCase()`.
fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn list<'a>(file: &'a Value, key: &str) -> &'a [Value] {
    file.get(key)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
}

/// `ownerOf()`: the owner as a person, so every list reads one shape.
pub fn owner_of(file: &Value) -> Value {
    let owner = file.get("owner").unwrap_or(&Value::Null);
    let mut p = json!({
        "id": OWNER_ID,
        "name": owner.get("name").cloned().unwrap_or(Value::Null),
        "role": "owner",
        "teams": [],
        "created": 0,
    });
    if let Some(c) = owner.get("color") {
        p["color"] = c.clone();
    }
    p
}

/// `personById()`.
pub fn person_by_id(file: &Value, id: &str) -> Option<Value> {
    if id == OWNER_ID {
        return Some(owner_of(file));
    }
    list(file, "people")
        .iter()
        .find(|p| p.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
}

/// `findPerson()`: a person by id or by name, as a CLI names one; names
/// compare without case.
pub fn find_person(file: &Value, r: &str) -> Option<Value> {
    let r = js_trim(r);
    person_by_id(file, r).or_else(|| {
        std::iter::once(owner_of(file))
            .chain(list(file, "people").iter().cloned())
            .find(|p| {
                p.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| same_name(n, r))
            })
    })
}

/// `findTeam()`: by id, then by name without case.
pub fn find_team(file: &Value, r: &str) -> Option<Value> {
    let r = js_trim(r);
    let teams = list(file, "teams");
    let field = |t: &Value, k: &str| t.get(k).and_then(Value::as_str).map(String::from);
    teams
        .iter()
        .find(|t| field(t, "id").as_deref() == Some(r))
        .or_else(|| {
            teams
                .iter()
                .find(|t| field(t, "name").is_some_and(|n| same_name(&n, r)))
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_is_found_by_id_or_by_name_without_case() {
        let f = json!({"owner": {"name": "Eric"}, "people": [{"id": "p-aaaaaaaa", "name": "Avery", "role": "member", "teams": [], "created": 1}], "teams": [], "invites": []});
        assert_eq!(find_person(&f, "avery").unwrap()["id"], "p-aaaaaaaa");
        assert_eq!(find_person(&f, "p-aaaaaaaa").unwrap()["name"], "Avery");
        assert_eq!(find_person(&f, "ERIC").unwrap()["id"], OWNER_ID);
        assert_eq!(find_person(&f, " owner ").unwrap()["name"], "Eric");
        assert!(find_person(&f, "nobody").is_none());
    }

    #[test]
    fn a_team_by_id_then_by_name() {
        let f =
            json!({"teams": [{"id": "t-aaaaaaaa", "name": "Rio", "folders": [], "created": 1}]});
        assert_eq!(find_team(&f, "rio").unwrap()["id"], "t-aaaaaaaa");
        assert_eq!(find_team(&f, "t-aaaaaaaa ").unwrap()["name"], "Rio");
        assert!(find_team(&f, "x").is_none());
    }

    #[test]
    fn the_roles_and_their_words() {
        assert!(is_role("viewer"));
        assert!(!is_role("boss"));
        assert_eq!(
            Role::Viewer.words(),
            "reads the board; starts and changes nothing"
        );
    }
}
