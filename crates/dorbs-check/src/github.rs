//! A GitHub App's installation tokens: each narrowed to one repo with read access, kept until five
//! minutes before it expires. The JWT is signed here; curl makes the two API calls, with every
//! credential on its stdin, so the binary needs no TLS stack of its own.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::DecodePrivateKey;
use rsa::signature::{RandomizedSigner, SignatureEncoding};

use crate::process::{self, Env, Spec};

/// A token this close to its expiry is not handed out: a fetch may outlast the rest.
const REFRESH_MARGIN: u64 = 5 * 60;

/// The owner and name of a github.com repo `url` names.
pub fn repo_of(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let (owner, name) = rest.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/'))
        .then(|| (owner.to_owned(), name.to_owned()))
}

pub struct App {
    id: String,
    key: SigningKey<rsa::sha2::Sha256>,
    api: String,
    /// Tokens by repo, with the second they stop being handed out.
    cache: Mutex<HashMap<String, (String, u64)>>,
    /// One mint per repo at a time.
    turns: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn base64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

impl App {
    /// The App, from its id and PKCS#8 PEM key.
    pub fn new(id: &str, pem: &str, api: &str) -> Result<App, String> {
        let key = rsa::RsaPrivateKey::from_pkcs8_pem(pem.trim())
            .map_err(|_| "GITHUB_APP_PRIVATE_KEY is not a PKCS#8 PEM RSA key".to_owned())?;
        Ok(App {
            id: id.to_owned(),
            key: SigningKey::new(key),
            api: api.trim_end_matches('/').to_owned(),
            cache: Mutex::new(HashMap::new()),
            turns: Mutex::new(HashMap::new()),
        })
    }

    /// GitHub refuses an App JWT that lives over ten minutes; iat sits a minute back for clock drift.
    fn jwt(&self) -> String {
        let now = now();
        let header = base64url(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = base64url(
            serde_json::json!({ "iat": now - 60, "exp": now + 540, "iss": self.id })
                .to_string()
                .as_bytes(),
        );
        let unsigned = format!("{header}.{claims}");
        let signature = self
            .key
            .sign_with_rng(&mut rand_core::OsRng, unsigned.as_bytes());
        format!("{unsigned}.{}", base64url(&signature.to_bytes()))
    }

    /// A read token for `owner/name`.
    pub async fn token(&self, owner: &str, name: &str) -> Result<String, String> {
        let repo = format!("{owner}/{name}");
        let turn = self
            .turns
            .lock()
            .expect("the turns")
            .entry(repo.clone())
            .or_default()
            .clone();
        let _turn = turn.lock().await;
        if let Some((token, until)) = self.cache.lock().expect("the cache").get(&repo).cloned()
            && now() < until
        {
            return Ok(token);
        }
        let bearer = self.jwt();
        let (status, body) = self
            .call(
                &bearer,
                "GET",
                &format!("/repos/{owner}/{name}/installation"),
                None,
            )
            .await?;
        if status == 404 {
            return Err(format!(
                "The GitHub App is not installed on {repo}. Install it on the repo to give dorbs access."
            ));
        }
        if status != 200 {
            return Err(refused(
                &format!("the installation of {repo}"),
                status,
                &body,
            ));
        }
        let installation = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v["id"].as_u64());
        let installation = installation.ok_or_else(|| {
            format!("GitHub answered the installation of {repo} with an unknown shape")
        })?;
        let request = serde_json::json!({ "repositories": [name], "permissions": { "contents": "read", "metadata": "read" } });
        let path = format!("/app/installations/{installation}/access_tokens");
        let (status, body) = self
            .call(&bearer, "POST", &path, Some(request.to_string()))
            .await?;
        if status != 201 {
            return Err(refused(&format!("a token for {repo}"), status, &body));
        }
        // The body holds the token, so a failure names no part of it.
        let answer: serde_json::Value = serde_json::from_str(&body)
            .map_err(|_| format!("GitHub answered a token for {repo} with an unknown shape"))?;
        let (Some(token), Some(expires)) =
            (answer["token"].as_str(), answer["expires_at"].as_str())
        else {
            return Err(format!(
                "GitHub answered a token for {repo} with an unknown shape"
            ));
        };
        let until = expiry(expires)
            .unwrap_or(now() + 3600)
            .saturating_sub(REFRESH_MARGIN);
        self.cache
            .lock()
            .expect("the cache")
            .insert(repo, (token.to_owned(), until));
        Ok(token.to_owned())
    }

    async fn call(
        &self,
        bearer: &str,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> Result<(u16, String), String> {
        let quoted =
            |value: &str| format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""));
        let mut config = vec![
            format!("url = {}", quoted(&format!("{}{path}", self.api))),
            format!("request = {}", quoted(method)),
            format!(
                "header = {}",
                quoted(&format!("Authorization: Bearer {bearer}"))
            ),
            format!("header = {}", quoted("Accept: application/vnd.github+json")),
            format!("header = {}", quoted("User-Agent: dorbs")),
            format!("header = {}", quoted("X-GitHub-Api-Version: 2022-11-28")),
        ];
        if let Some(body) = &body {
            config.push(format!(
                "header = {}",
                quoted("Content-Type: application/json")
            ));
            config.push(format!("data = {}", quoted(body)));
        }
        let config = config.join("\n") + "\n";
        let args = [
            "--silent",
            "--show-error",
            "--config",
            "-",
            "--write-out",
            "\n%{http_code}",
        ];
        let spec = Spec {
            program: "curl",
            args: &args,
            cwd: Path::new("/"),
            env: Env::Clean(&[]),
            timeout: Duration::from_secs(30),
            keep: 1 << 20,
            stdin: Some(config.into_bytes()),
        };
        let result = process::run(spec)
            .await
            .map_err(|e| format!("curl did not start: {e}"))?;
        let (answer, code) = result
            .stdout
            .rsplit_once('\n')
            .unwrap_or(("", &result.stdout));
        match code.trim().parse::<u16>() {
            Ok(code) if code != 0 => Ok((code, answer.to_owned())),
            _ => Err(format!(
                "{} did not answer: {}",
                self.api,
                result.stderr.trim()
            )),
        }
    }
}

fn refused(what: &str, status: u16, body: &str) -> String {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v["message"].as_str().map(str::to_owned));
    format!(
        "GitHub refused {what}: HTTP {status}: {}",
        message.unwrap_or_else(|| "no message".to_owned())
    )
}

/// The second an ISO 8601 UTC time such as 2026-10-31T12:00:00Z names.
fn expiry(text: &str) -> Option<u64> {
    let digits = |range: std::ops::Range<usize>| text.get(range)?.parse::<i64>().ok();
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    // Days from the civil date, as in Howard Hinnant's algorithm.
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    u64::try_from(days * 86400 + hour * 3600 + minute * 60 + second).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_github_repo_of_a_url() {
        assert_eq!(
            repo_of("https://github.com/maximilionai/dorbs-sandbox"),
            Some(("maximilionai".into(), "dorbs-sandbox".into()))
        );
        assert_eq!(
            repo_of("https://github.com/cli/cli.git/"),
            Some(("cli".into(), "cli".into()))
        );
        assert_eq!(repo_of("https://gitlab.com/a/b"), None);
        assert_eq!(repo_of("https://github.com/a/b/c"), None);
    }

    #[test]
    fn reads_githubs_expiry_times() {
        assert_eq!(expiry("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(expiry("2026-10-31T12:00:00Z"), Some(1_793_448_000));
        assert_eq!(expiry("soon"), None);
    }
}
