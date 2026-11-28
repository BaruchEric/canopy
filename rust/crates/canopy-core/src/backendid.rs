//! Backend-qualified ids (`src/core/backendid.ts`), whole: the home
//! backend's ids stay bare, another backend's carry its name and a bar.

/// What stands between a backend's name and an id it minted (`SEP`).
pub const SEP: char = '|';

/// The backends a page or a CLI talks to (`Reg`): the home one, and all of
/// them in the registry's order, home among them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reg {
    pub home: String,
    pub names: Vec<String>,
}

/// `qualify()`: an id as the page holds it.
pub fn qualify(reg: &Reg, backend: &str, id: &str) -> String {
    if backend == reg.home {
        id.to_string()
    } else {
        format!("{backend}{SEP}{id}")
    }
}

/// `split()`: the backend an id belongs to and the id that backend knows. A
/// prefix counts only when it names another backend in the registry.
pub fn split(reg: &Reg, id: &str) -> (String, String) {
    if let Some(i) = id.find(SEP)
        && i > 0
    {
        let name = &id[..i];
        if name != reg.home && reg.names.iter().any(|n| n == name) {
            return (name.to_string(), id[i + 1..].to_string());
        }
    }
    (reg.home.clone(), id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_ids_stay_bare_and_a_prefix_counts_only_for_a_listed_backend() {
        let reg = Reg {
            home: "mac".into(),
            names: vec!["mac".into(), "mini".into()],
        };
        assert_eq!(qualify(&reg, "mac", "app"), "app");
        assert_eq!(qualify(&reg, "mini", "app"), "mini|app");
        assert_eq!(split(&reg, "mini|app"), ("mini".into(), "app".into()));
        assert_eq!(split(&reg, "app"), ("mac".into(), "app".into()));
        assert_eq!(split(&reg, "far|app"), ("mac".into(), "far|app".into()));
        assert_eq!(split(&reg, "mac|app"), ("mac".into(), "mac|app".into()));
        assert_eq!(split(&reg, "|app"), ("mac".into(), "|app".into()));
    }
}
