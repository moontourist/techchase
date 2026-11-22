use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codes::InputCode;
use crate::gcu::MapEntry;
use crate::layout::layout_of;

pub const NAME_MAX_CHARS: usize = 40;
pub const FILE_VERSION: u8 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub pairs: Vec<(String, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProfilesFile<'a> {
    #[serde(rename = "gcuProfiles")]
    version: u8,
    profiles: &'a [Profile],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileError {
    NotJson(String),
    NotAProfilesFile,
    MissingButton(String),
}

impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotJson(e) => write!(f, "not a JSON file: {e}"),
            Self::NotAProfilesFile => f.write_str("not a GCU profiles file"),
            Self::MissingButton(name) => {
                write!(f, "this controller has no \u{201c}{name}\u{201d} button")
            }
        }
    }
}

impl std::error::Error for ProfileError {}

fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => v.to_string(),
    }
}

fn clean(v: &Value) -> Option<Profile> {
    let name = v.get("name")?.as_str()?.chars().take(NAME_MAX_CHARS).collect();
    let pairs = v
        .get("pairs")?
        .as_array()?
        .iter()
        .filter_map(|p| match p.as_array()?.as_slice() {
            [a, b] => Some((text(a), text(b))),
            _ => None,
        })
        .collect();
    Some(Profile {
        name,
        pairs,
        board: None,
        saved: None,
    })
}

pub fn parse_file(json: &str) -> Result<Vec<Profile>, ProfileError> {
    let data: Value =
        serde_json::from_str(json).map_err(|e| ProfileError::NotJson(e.to_string()))?;
    let marked = data
        .get("gcuProfiles")
        .is_some_and(|m| m.as_bool() != Some(false) && !m.is_null() && m != 0);
    let list = data
        .get("profiles")
        .and_then(Value::as_array)
        .filter(|_| marked)
        .ok_or(ProfileError::NotAProfilesFile)?;
    Ok(list.iter().filter_map(clean).collect())
}

pub fn to_file(profiles: &[Profile]) -> Result<String, ProfileError> {
    serde_json::to_string_pretty(&ProfilesFile {
        version: FILE_VERSION,
        profiles,
    })
    .map_err(|e| ProfileError::NotJson(e.to_string()))
}

pub fn merge(into: &mut Vec<Profile>, incoming: Vec<Profile>) -> usize {
    let n = incoming.len();
    for p in incoming {
        match into.iter_mut().find(|q| q.name == p.name) {
            Some(slot) => *slot = p,
            None => into.push(p),
        }
    }
    n
}

pub fn resolve(
    profile: &Profile,
    entries: &[MapEntry],
) -> Result<Vec<(InputCode, InputCode)>, ProfileError> {
    let by_name: HashMap<&str, InputCode> =
        entries.iter().map(|e| (e.name.as_str(), e.code)).collect();
    let code =
        |n: &str| by_name.get(n).copied().ok_or_else(|| ProfileError::MissingButton(n.to_owned()));
    profile.pairs.iter().map(|(s, t)| Ok((code(s)?, code(t)?))).collect()
}

#[must_use]
pub fn named_layout(entries: &[MapEntry]) -> Vec<(String, String)> {
    let by_code: HashMap<InputCode, &str> =
        entries.iter().map(|e| (e.code, e.name.as_str())).collect();
    layout_of(entries)
        .into_iter()
        .filter_map(|(s, t)| Some(((*by_code.get(&s)?).to_owned(), (*by_code.get(&t)?).to_owned())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codes::{GcCode, SwCode};

    fn entry(code: u8, cur: i8, def: i8, name: &str) -> MapEntry {
        MapEntry {
            code: InputCode(code),
            gc_cur: GcCode(cur),
            gc_def: GcCode(def),
            sw_cur: SwCode(def),
            sw_def: SwCode(def),
            name: name.to_owned(),
        }
    }

    fn entries() -> Vec<MapEntry> {
        vec![
            entry(9, 2, 9, "ZR"),
            entry(1, 9, 2, "X"),
            entry(0, 0, 0, "A"),
        ]
    }

    #[test]
    fn layout_by_name_and_back() {
        let named = named_layout(&entries());
        assert_eq!(named, vec![
            ("X".to_owned(), "ZR".to_owned()),
            ("ZR".to_owned(), "X".to_owned())
        ]);
        let p = Profile {
            name: "jump on R".to_owned(),
            pairs: named,
            board: None,
            saved: None,
        };
        assert_eq!(
            resolve(&p, &entries()),
            Ok(vec![(InputCode(1), InputCode(9)), (InputCode(9), InputCode(1))])
        );
        let bad = Profile {
            pairs: vec![("ZR".to_owned(), "Plus".to_owned())],
            ..p
        };
        assert_eq!(
            resolve(&bad, &entries()),
            Err(ProfileError::MissingButton("Plus".to_owned()))
        );
    }

    #[test]
    fn reads_the_apps_files() {
        let long = "n".repeat(50);
        let json = format!(
            r#"{{"gcuProfiles":1,"profiles":[
                {{"name":"Wolf","pairs":[["ZR","X"],["X","ZR"]],"board":"GCU 1","saved":"2026-11-21T10:00:00Z"}},
                {{"name":"{long}","pairs":[["A",1],["B"],"C"]}},
                {{"name":5,"pairs":[]}},
                {{"pairs":[]}}
            ]}}"#
        );
        let p = parse_file(&json).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pairs, vec![
            ("ZR".to_owned(), "X".to_owned()),
            ("X".to_owned(), "ZR".to_owned())
        ]);
        assert_eq!(p[1].name.chars().count(), NAME_MAX_CHARS);
        assert_eq!(p[1].pairs, vec![("A".to_owned(), "1".to_owned())]);
        assert_eq!(
            parse_file(r#"{"profiles":[]}"#),
            Err(ProfileError::NotAProfilesFile)
        );
        assert_eq!(
            parse_file(r#"{"gcuProfiles":1,"profiles":{}}"#),
            Err(ProfileError::NotAProfilesFile)
        );
        assert!(matches!(parse_file("nope"), Err(ProfileError::NotJson(_))));
    }

    #[test]
    fn writes_what_it_reads() {
        let all = vec![Profile {
            name: "Wolf".to_owned(),
            pairs: vec![("ZR".to_owned(), "X".to_owned())],
            board: Some("GCU 1".to_owned()),
            saved: None,
        }];
        let text = to_file(&all).unwrap();
        assert!(text.contains("\"gcuProfiles\": 1"));
        let back = parse_file(&text).unwrap();
        assert_eq!((back[0].name.as_str(), &back[0].pairs), ("Wolf", &all[0].pairs));
    }

    #[test]
    fn merge_replaces_by_name() {
        let mut all = parse_file(
            r#"{"gcuProfiles":1,"profiles":[{"name":"a","pairs":[]},{"name":"b","pairs":[]}]}"#,
        )
        .unwrap();
        let incoming = vec![Profile {
            name: "b".to_owned(),
            pairs: vec![("A".to_owned(), "B".to_owned())],
            board: None,
            saved: None,
        }];
        assert_eq!(merge(&mut all, incoming), 1);
        assert_eq!(all.len(), 2);
        assert_eq!(all[1].pairs.len(), 1);
    }
}
