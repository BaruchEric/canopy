//! Repos as board cards (`src/core/cards.ts`), whole: checkouts of one repo
//! on different backends on one card. A checkout stays the repo's JSON, as
//! a backend's `/api/tree` serves it.

use crate::js::{template, truthy_at};
use crate::remote::web_url;
use serde_json::Value;
use std::collections::HashMap;

/// One repo on the board, with every machine that has it checked out
/// (`RepoCard`).
#[derive(Debug, Clone, PartialEq)]
pub struct RepoCard {
    /// the first remote with a web page as lowercase host/owner/name,
    /// `rel:<plain id>` without one, `forge:<id>` for a forge-only repo;
    /// `#<plain id>` after it for a second checkout on one backend
    pub key: String,
    pub name: String,
    /// at most one per backend, in the registry's order; never empty
    pub checkouts: Vec<Value>,
}

/// `${repo.id}`.
fn id_of(r: &Value) -> String {
    template(r.get("id"))
}

/// `remoteKey()`: a repo's first remote that maps to a web page, as
/// lowercase host/owner/name.
pub fn remote_key(repo: &Value) -> Option<String> {
    let remotes = repo.get("remotes").and_then(Value::as_array)?;
    for url in remotes {
        let Some(web) = url.as_str().and_then(web_url) else {
            continue;
        };
        let Ok(u) = url::Url::parse(&web) else {
            continue;
        };
        // URL's host: the name and a port that is not the scheme's own
        let host = match u.port() {
            Some(p) => format!("{}:{p}", u.host_str().unwrap_or("")),
            None => u.host_str().unwrap_or("").to_string(),
        };
        return Some(format!("{host}{}", u.path()).to_lowercase());
    }
    None
}

/// `joinRepos()`: every repo as a card, checkouts of one repo on different
/// backends on one card. A second checkout on a backend that already has
/// one on the card gets its own, so one backend's board is one card per
/// repo, in the order given.
pub fn join_repos(
    repos: &[Value],
    names: &[String],
    split: impl Fn(&str) -> (String, String),
) -> Vec<RepoCard> {
    let rank = |r: &Value| -> usize {
        let backend = split(&id_of(r)).0;
        names
            .iter()
            .position(|n| *n == backend)
            .unwrap_or(names.len())
    };
    let mut sorted: Vec<&Value> = repos.iter().collect();
    sorted.sort_by_key(|r| rank(r));
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<RepoCard> = Vec::new();
    for r in sorted {
        let id = id_of(r);
        let (backend, plain) = split(&id);
        let base = if truthy_at(r, "forge") {
            format!("forge:{id}")
        } else {
            remote_key(r).unwrap_or_else(|| format!("rel:{plain}"))
        };
        // Two checkouts of one remote on one backend are two cards. Another
        // backend's checkout goes to the card that already holds its plain
        // id, else to the base card, as long as the card has none on that
        // backend.
        let free = |c: &RepoCard| !c.checkouts.iter().any(|x| split(&id_of(x)).0 == backend);
        let twin = out.iter().find(|c| {
            (c.key == base || c.key.starts_with(&format!("{base}#")))
                && free(c)
                && c.checkouts.iter().any(|x| split(&id_of(x)).1 == plain)
        });
        let key = match twin {
            Some(c) => c.key.clone(),
            None => {
                let at_base = by_key.get(&base).map(|&i| &out[i]);
                if at_base.is_none_or(free) {
                    base.clone()
                } else {
                    format!("{base}#{plain}")
                }
            }
        };
        let i = match by_key.get(&key) {
            Some(&i) => i,
            None => {
                out.push(RepoCard {
                    key: key.clone(),
                    name: template(r.get("name")),
                    checkouts: Vec::new(),
                });
                by_key.insert(key, out.len() - 1);
                out.len() - 1
            }
        };
        out[i].checkouts.push(r.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backendid::{Reg, split};
    use serde_json::json;

    fn repo(id: &str, name: &str, remote: Option<&str>) -> Value {
        let mut r = json!({"id": id, "name": name, "path": format!("/{name}")});
        if let Some(u) = remote {
            r["remotes"] = json!([u]);
        }
        r
    }

    #[test]
    fn the_first_remote_with_a_web_page_keys_the_card() {
        assert_eq!(
            remote_key(&json!({"remotes": ["mini:dev/x", "git@GitHub.com:Eric/Canopy.git"]})),
            Some("github.com/eric/canopy".into())
        );
        assert_eq!(
            remote_key(&json!({"remotes": ["https://git.example.com:3000/e/x.git"]})),
            Some("git.example.com:3000/e/x".into())
        );
        assert_eq!(remote_key(&json!({"remotes": ["mini:dev/x"]})), None);
        assert_eq!(remote_key(&json!({})), None);
    }

    #[test]
    fn checkouts_of_one_repo_share_a_card_and_a_second_on_one_backend_gets_its_own() {
        let reg = Reg {
            home: "mac".into(),
            names: vec!["mac".into(), "mini".into()],
        };
        let gh = "https://github.com/e/canopy";
        let repos = vec![
            repo("mini|canopy", "canopy on mini", Some(gh)),
            repo("canopy", "canopy", Some(gh)),
            repo("canopy-2", "canopy copy", Some(gh)),
            repo("notes", "notes", None),
            repo("mini|notes", "notes", None),
            json!({"id": "forge-x", "name": "x", "forge": {"id": 1}}),
        ];
        let cards = join_repos(&repos, &reg.names, |id| split(&reg, id));
        let shape: Vec<(String, String, Vec<String>)> = cards
            .iter()
            .map(|c| {
                (
                    c.key.clone(),
                    c.name.clone(),
                    c.checkouts.iter().map(id_of).collect(),
                )
            })
            .collect();
        assert_eq!(
            shape,
            [
                (
                    "github.com/e/canopy".to_string(),
                    "canopy".to_string(),
                    vec!["canopy".to_string(), "mini|canopy".to_string()]
                ),
                (
                    "github.com/e/canopy#canopy-2".into(),
                    "canopy copy".into(),
                    vec!["canopy-2".into()]
                ),
                (
                    "rel:notes".into(),
                    "notes".into(),
                    vec!["notes".into(), "mini|notes".into()]
                ),
                ("forge:forge-x".into(), "x".into(), vec!["forge-x".into()]),
            ]
        );
    }
}
