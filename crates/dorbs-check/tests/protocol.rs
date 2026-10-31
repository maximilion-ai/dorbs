//! The wire contract the TypeScript schemas hold too: packages/protocol/fixtures/checker.

use std::fs;
use std::path::Path;

use dorbs_check::protocol::{CheckRequest, CheckResponse, TestRequest, TestResponse};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../packages/protocol/fixtures/checker"
);

fn round_trip<T: Serialize + DeserializeOwned>(json: &Value) -> Result<Value, String> {
    let value: T = serde_json::from_value(json.clone()).map_err(|e| e.to_string())?;
    serde_json::to_value(value).map_err(|e| e.to_string())
}

fn check(name: &str, json: &Value) -> Result<Value, String> {
    match name.split('.').next() {
        Some("CheckRequest") => round_trip::<CheckRequest>(json),
        Some("TestRequest") => round_trip::<TestRequest>(json),
        Some("CheckResponse") => round_trip::<CheckResponse>(json),
        Some("TestResponse") => round_trip::<TestResponse>(json),
        _ => panic!("{name} names no message"),
    }
}

fn fixtures(dir: &Path) -> Vec<(String, Value)> {
    let mut found: Vec<(String, Value)> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .map(|path| {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            (
                name,
                serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap(),
            )
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

#[test]
fn decodes_every_valid_fixture_and_encodes_it_back_to_the_same_json() {
    let valid = fixtures(Path::new(FIXTURES));
    assert!(valid.len() >= 16, "{} fixtures", valid.len());
    for (name, json) in valid {
        assert_eq!(check(&name, &json), Ok(json), "{name}");
    }
}

#[test]
fn refuses_every_invalid_fixture() {
    let invalid = fixtures(&Path::new(FIXTURES).join("invalid"));
    assert!(invalid.len() >= 34, "{} fixtures", invalid.len());
    for (name, json) in invalid {
        assert!(check(&name, &json).is_err(), "{name} was accepted");
    }
}
