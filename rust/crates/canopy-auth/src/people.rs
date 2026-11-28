//! The slice of `src/core/people.ts` the gate needs: roles, what each holds,
//! the owner's id and an invite code's shape. A caller's rights are its
//! kind's and its person's role's, both (FR-074).

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::rights::{CallerKind, Need, Right, allows};
use crate::text::js_trim;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Member,
    Viewer,
}

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
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The built-in person: never in the file's list, never removed or demoted.
pub const OWNER_ID: &str = "owner";

/// What a role may hold. A member works and changes nothing about the
/// backend; a viewer reads the board.
pub fn role_rights(role: Role) -> &'static [Right] {
    use Right::*;
    match role {
        Role::Owner | Role::Admin => &Right::ALL,
        Role::Member => &[Read, Plan, Operate, Shell, Helper],
        Role::Viewer => &[Read],
    }
}

pub fn role_allows(role: Role, need: impl Into<Need>) -> bool {
    match need.into() {
        Need::Open => true,
        Need::Right(r) => role_rights(role).contains(&r),
    }
}

/// Whether a caller of this kind, whose person has this role, holds a need.
pub fn allows_as(kind: CallerKind, role: Role, need: impl Into<Need>) -> bool {
    let need = need.into();
    allows(kind, need) && role_allows(role, need)
}

/// Every right a caller holds, for the page to ask once.
pub fn rights_of(kind: CallerKind, role: Role) -> Vec<Right> {
    Right::ALL
        .into_iter()
        .filter(|r| allows_as(kind, role, *r))
        .collect()
}

/// An invite as typed: trimmed and lowercased, or None when it is not one
/// (`cnv_` and 24 base32 characters).
pub fn invite_code(raw: &str) -> Option<String> {
    let c = js_trim(raw).to_lowercase();
    let body = c.strip_prefix("cnv_")?;
    let ok = body.len() == 24 && body.bytes().all(|b| matches!(b, b'a'..=b'z' | b'2'..=b'7'));
    ok.then_some(c)
}

/// What `GET /api/auth` says of the caller's person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Me {
    pub id: String,
    pub name: String,
    pub role: Role,
}
