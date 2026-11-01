//! The service's settings, from its environment and the operator's repos file.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use crate::adapter::Adapters;
use crate::docker::{Egress, Limits};
use crate::protocol::RepoId;

/// How a fetch gets the repo's read token.
pub enum Token {
    None,
    /// The environment variable that holds it.
    Env(String),
    /// One the GitHub App mints for this github.com repo.
    App {
        owner: String,
        name: String,
    },
}

/// A repo the operator registered.
pub struct Repo {
    pub id: RepoId,
    pub url: String,
    pub token: Token,
    /// The operator's recipe for the repo, as JSON, which wins over the commit's.
    pub recipe: Option<String>,
}

pub struct Settings {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub token: String,
    pub repos: HashMap<RepoId, Repo>,
    pub adapters: Adapters,
    /// Bytes the environments may take on disk before the least recently used are evicted.
    pub disk_budget: u64,
    /// How long a warm environment's container runs without a request before it is stopped.
    pub idle_after: Duration,
    /// How long after a failed setup a request gets the failure again instead of a new setup.
    pub retry_setup_after: Duration,
    pub setup_timeout: Duration,
    pub check_timeout: Duration,
    pub test_timeout: Duration,
    /// How long a complete check's answer serves the same request again; zero never.
    pub remember_checks: Duration,
    /// How many checks and tests run at once across environments; each environment runs one at a time.
    pub run_slots: usize,
    pub replicas: usize,
    pub limits: Limits,
    pub egress: Egress,
    /// The egress proxy's allowed hosts; the adapters' when EGRESS_ALLOW is unset.
    pub egress_allow: Vec<String>,
    /// What the names of the service's containers, network and label start with.
    pub prefix: String,
    pub app: Option<crate::github::App>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Registration {
    id: RepoId,
    url: String,
    /// Names the environment variable that holds the repo's read token.
    token_env: Option<String>,
    /// A public repo: fetched without a token, even when the GitHub App is set.
    #[serde(default)]
    public: bool,
    /// A .dorbs/check.json for a repo the operator cannot commit one to.
    recipe: Option<serde_json::Value>,
}

/// A duration as Effect writes one, such as "10 minutes" or "30 seconds"; a bare number is milliseconds.
pub fn duration(text: &str) -> Result<Duration, String> {
    let text = text.trim();
    let (number, unit) = text.split_at(
        text.find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(text.len()),
    );
    let n: f64 = number
        .parse()
        .map_err(|_| format!("{text:?} is not a duration"))?;
    let factor = match unit.trim() {
        "" | "ms" | "milli" | "millis" | "millisecond" | "milliseconds" => 0.001,
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
        "h" | "hour" | "hours" => 3600.0,
        "d" | "day" | "days" => 86400.0,
        _ => return Err(format!("{text:?} is not a duration")),
    };
    let seconds = n * factor;
    Ok(Duration::from_secs_f64(seconds))
}

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn required(name: &str) -> Result<String, String> {
    var(name).ok_or_else(|| format!("{name} is not set"))
}

fn parsed<T: std::str::FromStr>(name: &str, default: T) -> Result<T, String> {
    var(name).map_or(Ok(default), |value| {
        value
            .parse()
            .map_err(|_| format!("{name}={value:?} does not parse"))
    })
}

fn timeout(name: &str, default: Duration) -> Result<Duration, String> {
    var(name).map_or(Ok(default), |value| {
        duration(&value).map_err(|e| format!("{name}: {e}"))
    })
}

pub fn load() -> Result<Settings, String> {
    let adapters = Adapters::load(var("ADAPTERS_DIR").map(PathBuf::from).as_deref())?;
    let repos_file = required("REPOS_FILE")?;
    let text = std::fs::read_to_string(&repos_file).map_err(|e| format!("{repos_file}: {e}"))?;
    let registrations: Vec<Registration> =
        serde_json::from_str(&text).map_err(|e| format!("{repos_file}: {e}"))?;
    let app = match (var("GITHUB_APP_ID"), var("GITHUB_APP_PRIVATE_KEY")) {
        (Some(id), Some(key)) => Some(crate::github::App::new(
            &id,
            &key,
            &var("GITHUB_API_URL").unwrap_or_else(|| "https://api.github.com".into()),
        )?),
        (None, None) => None,
        _ => return Err("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY go together".to_owned()),
    };
    let mut repos = HashMap::new();
    for registration in registrations {
        let token = match (
            &registration.token_env,
            crate::github::repo_of(&registration.url),
        ) {
            (Some(name), _) => Token::Env(name.clone()),
            (None, Some((owner, name))) if !registration.public && app.is_some() => {
                Token::App { owner, name }
            }
            _ => Token::None,
        };
        let repo = Repo {
            id: registration.id.clone(),
            url: registration.url,
            token,
            recipe: registration.recipe.map(|recipe| recipe.to_string()),
        };
        if repos.insert(registration.id.clone(), repo).is_some() {
            return Err(format!(
                "{repos_file}: {} is registered twice",
                registration.id
            ));
        }
    }
    let egress_allow = match var("EGRESS_ALLOW") {
        Some(list) => crate::egress::allow_list(&list),
        None => {
            let mut hosts: Vec<String> = adapters
                .list
                .iter()
                .flat_map(|a| a.egress.clone())
                .collect();
            hosts.sort();
            hosts.dedup();
            hosts
        }
    };
    Ok(Settings {
        host: var("HOST").unwrap_or_else(|| "127.0.0.1".into()),
        port: parsed("PORT", 8080)?,
        data_dir: PathBuf::from(required("DATA_DIR")?),
        token: required("CHECK_TOKEN")?,
        repos,
        adapters,
        disk_budget: parsed("DISK_BUDGET", 12 * 1024u64.pow(3))?,
        idle_after: timeout("IDLE_AFTER", Duration::from_secs(600))?,
        retry_setup_after: timeout("RETRY_SETUP_AFTER", Duration::from_secs(600))?,
        setup_timeout: timeout("SETUP_TIMEOUT", Duration::from_secs(1200))?,
        check_timeout: timeout("CHECK_TIMEOUT", Duration::from_secs(300))?,
        test_timeout: timeout("TEST_TIMEOUT", Duration::from_secs(600))?,
        remember_checks: timeout("REMEMBER_CHECKS", Duration::from_secs(600))?,
        run_slots: parsed("RUN_SLOTS", 4)?,
        replicas: parsed("REPLICAS", 1)?,
        limits: Limits {
            memory: var("CONTAINER_MEMORY").unwrap_or_else(|| "8g".into()),
            setup_memory: var("SETUP_MEMORY").unwrap_or_else(|| "8g".into()),
            cpus: var("CONTAINER_CPUS").unwrap_or_else(|| "4".into()),
            pids: parsed("CONTAINER_PIDS", 2048)?,
            cgroup_parent: var("CONTAINER_CGROUP_PARENT"),
        },
        egress: match var("SETUP_EGRESS").as_deref() {
            None | Some("proxy") => Egress::Proxy,
            Some("open") => Egress::Open,
            Some(other) => return Err(format!("SETUP_EGRESS={other:?}: proxy or open")),
        },
        egress_allow,
        prefix: var("CONTAINER_PREFIX").unwrap_or_else(|| "dorbs".into()),
        app,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_durations_as_effect_writes_them() {
        assert_eq!(duration("10 minutes"), Ok(Duration::from_secs(600)));
        assert_eq!(duration("30 seconds"), Ok(Duration::from_secs(30)));
        assert_eq!(duration("1 hour"), Ok(Duration::from_secs(3600)));
        assert_eq!(duration("1500"), Ok(Duration::from_millis(1500)));
        assert_eq!(duration("250 millis"), Ok(Duration::from_millis(250)));
        assert!(duration("soon").is_err());
    }
}
