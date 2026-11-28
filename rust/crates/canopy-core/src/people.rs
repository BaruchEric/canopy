//! People, roles and teams (`src/core/people.ts`), the parts `canopy
//! people` reads: the roles and their words, and finding a person or a team
//! by id or by name in a roster as the API sends it (a people file's
//! shape: `owner`, `people`, `teams`). The roles and rights the gate needs
//! are canopy-auth's `people.rs` (a typed `Role`; the CLI does not depend
//! on that crate, so the role names are kept here as strings too). The
//! rules on who may change whom, the invites and the activity log stay in
//! the TypeScript.

use crate::pathx::js_trim;
use serde_json::{Value, json};

/// `ROLES`.
pub const ROLES: &[&str] = &["owner", "admin", "member", "viewer"];

/// `OWNER_ID`: the built-in person.
pub const OWNER_ID: &str = "owner";

/// `ROLE_WORDS`: what each role is, in a line.
pub fn role_words(role: &str) -> &'static str {
    match role {
        "owner" => "everything, and the only one who makes or changes an owner",
        "admin" => "everything but changing an owner: people, sources, the kit, secrets",
        "member" => "runs, chats, shells and commits; no settings, people or secrets",
        _ => "reads the board; starts and changes nothing",
    }
}

/// `isRole()`.
pub fn is_role(v: &str) -> bool {
    ROLES.contains(&v)
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
            role_words("viewer"),
            "reads the board; starts and changes nothing"
        );
    }
}
