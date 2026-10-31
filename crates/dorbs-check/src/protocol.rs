//! The checker's requests and answers, as `packages/protocol/src/checker.ts` defines them. The
//! fixtures in `packages/protocol/fixtures/checker` hold both sides to the same JSON.

use std::fmt;

use serde::{Deserialize, Serialize};

/// Declares a string newtype that only holds values `valid` accepts, checked when it is parsed.
macro_rules! checked_string {
    ($(#[$doc:meta])* $name:ident, $expected:literal, $valid:expr) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = String;
            fn try_from(value: String) -> Result<Self, String> {
                let valid: fn(&str) -> bool = $valid;
                if valid(&value) {
                    Ok(Self(value))
                } else {
                    Err(format!("expected {}, got {:?}", $expected, value))
                }
            }
        }

        impl TryFrom<&str> for $name {
            type Error = String;
            fn try_from(value: &str) -> Result<Self, String> {
                Self::try_from(value.to_owned())
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl std::ops::Deref for $name {
            type Target = str;
            fn deref(&self) -> &str {
                &self.0
            }
        }
    };
}

fn is_path_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && !segment.chars().any(|c| c == '\\' || c.is_ascii_control())
}

fn is_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

checked_string!(
    /// A path inside the repo, checked per segment, so no character can hide a `..`.
    RelativePath,
    "a relative POSIX path without . or .. segments",
    |path| path.split('/').all(is_path_segment)
);

checked_string!(
    /// A repo as owner/name; the service keeps a repo's cache under it.
    RepoId,
    "a repo id such as owner/name",
    |id| {
        let names: Vec<&str> = id.split('/').collect();
        names.len() == 2 && names.iter().all(|name| is_repo_name(name))
    }
);

checked_string!(CommitSha, "a full lowercase hex commit SHA", |sha| sha
    .len()
    == 40
    && sha
        .bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));

checked_string!(
    /// Names one of a recipe's checks, such as typecheck or lint.
    CheckId,
    "a check id",
    |id| {
        let mut bytes = id.bytes();
        bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
            && bytes.all(|b| b.is_ascii_alphanumeric() || b":._-".contains(&b))
    }
);

checked_string!(NonEmptyString, "a non-empty string", |s| !s.is_empty());

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct File {
    pub path: RelativePath,
    pub content: String,
}

/// How a workspace differs from the commit it was cloned from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    /// Files that differ from the commit, new files included, with their whole content.
    pub files: Vec<File>,
    /// Files of the commit that the workspace deleted.
    pub deleted: Vec<RelativePath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRequest {
    pub repo: RepoId,
    pub commit: CommitSha,
    pub change: Change,
    /// Runs only these checks; all of the recipe's when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub only: Option<Vec<CheckId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestRequest {
    pub repo: RepoId,
    pub commit: CommitSha,
    pub change: Change,
    /// Test files, or for pytest, test ids such as tests/test_a.py::test_b.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Vec<NonEmptyString>>,
    /// A test name pattern.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<NonEmptyString>,
}

/// A zero-based position, as in the Language Server Protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Range {
    pub start: Position,
    pub end: Position,
}

/// LSP's DiagnosticSeverity: 1 error, 2 warning, 3 information, 4 hint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u8", into = "u8")]
pub enum Severity {
    Error = 1,
    Warning = 2,
    Information = 3,
    Hint = 4,
}

impl TryFrom<u8> for Severity {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, String> {
        match value {
            1 => Ok(Self::Error),
            2 => Ok(Self::Warning),
            3 => Ok(Self::Information),
            4 => Ok(Self::Hint),
            _ => Err(format!("expected a severity from 1 to 4, got {value}")),
        }
    }
}

impl From<Severity> for u8 {
    fn from(value: Severity) -> u8 {
        value as u8
    }
}

/// An LSP diagnostic with the file it is in, relative to the repo root, and the check that reported it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Diagnostic {
    pub path: RelativePath,
    pub range: Range,
    pub severity: Severity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub source: String,
    pub message: String,
}

/// How a run ended: exit 0, another exit, killed at its deadline, or not started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Passed,
    Failed,
    TimedOut,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    pub id: CheckId,
    pub command: String,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub diagnostics: Vec<Diagnostic>,
    /// Output lines no parser understood, so nothing the tool said is dropped. Capped.
    pub output: Vec<String>,
    /// Whether the service cut the output at its cap, so diagnostics may be missing.
    pub truncated: bool,
}

/// repo: the checks covered the whole repo. changed: some only looked at the changed files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Repo,
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// The environment the run used: a hash of the repo, the recipe, its key files and the image.
    pub env_key: String,
    pub duration_ms: u64,
    /// Time spent setting up the environment, 0 when it was warm.
    pub setup_ms: u64,
    /// Time spent laying the change over the environment's tree and taking it off again.
    pub overlay_ms: u64,
    pub scope: Scope,
    /// Whether every check ran to its end with its whole output read.
    pub complete: bool,
    pub checks: Vec<CheckRun>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub env_key: String,
    pub duration_ms: u64,
    pub setup_ms: u64,
    pub overlay_ms: u64,
    pub command: String,
    pub status: RunStatus,
    pub exit_code: Option<i32>,
    /// Counts the runner reported; absent when its report was not read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<u64>,
    /// The runner's output, its tail kept when cut.
    pub output: String,
    pub truncated: bool,
}

/// The environment's setup failed; the next request after the retry delay sets it up again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFailed {
    pub env_key: String,
    pub step: String,
    pub output: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum RejectReason {
    UnknownRepo {},
    UnknownCommit {},
    /// No adapter matches the repo, and it names no image.
    NoRecipe {
        reason: String,
    },
    UnknownChecks {
        ids: Vec<String>,
        known: Vec<CheckId>,
    },
    NoTestCommand {
        reason: String,
    },
    /// A path the change writes goes through a symbolic link of the tree.
    UnsafePath {
        paths: Vec<RelativePath>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum CheckResponse {
    CheckResult(CheckResult),
    SetupFailed(SetupFailed),
    Rejected { reason: RejectReason },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "_tag")]
pub enum TestResponse {
    TestResult(TestResult),
    SetupFailed(SetupFailed),
    Rejected { reason: RejectReason },
}
