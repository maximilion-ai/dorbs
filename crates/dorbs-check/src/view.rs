//! A repo's files at one commit with a change laid over them, as recipe resolution and the
//! environment key see them.

use std::collections::{BTreeSet, HashMap, HashSet};

use globset::GlobSet;

use crate::protocol::{Change, File, RelativePath};

/// The recipe file a commit may carry.
pub const RECIPE_FILE: &str = ".dorbs/check.json";

#[derive(Debug, Clone, Default)]
pub struct View {
    paths: Vec<RelativePath>,
    files: HashMap<String, String>,
}

impl View {
    /// `paths` are the commit's, `files` the content of those the adapters read. The change's
    /// writes and deletes apply, except to `commit_only` files, which steer setup and so come from
    /// the commit alone.
    pub fn new(
        paths: Vec<RelativePath>,
        mut files: HashMap<String, String>,
        change: &Change,
        commit_only: &GlobSet,
    ) -> Self {
        let deleted: HashSet<&str> = (change.deleted.iter())
            .map(|path| path.as_str())
            .filter(|path| !commit_only.is_match(path))
            .collect();
        let written: Vec<&File> = (change.files.iter())
            .filter(|file| !commit_only.is_match(file.path.as_str()))
            .collect();
        for path in &deleted {
            files.remove(*path);
        }
        for file in &written {
            files.insert(file.path.to_string(), file.content.clone());
        }
        let all: BTreeSet<RelativePath> = (paths.into_iter())
            .filter(|path| !deleted.contains(path.as_str()))
            .chain(written.iter().map(|file| file.path.clone()))
            .collect();
        Self {
            paths: all.into_iter().collect(),
            files,
        }
    }

    pub fn paths(&self) -> &[RelativePath] {
        &self.paths
    }

    pub fn read(&self, path: &str) -> Option<&str> {
        self.files.get(path).map(String::as_str)
    }

    /// Every directory that holds a file, the root as ".".
    pub fn dirs(&self) -> HashSet<String> {
        let mut dirs = HashSet::from([".".to_owned()]);
        for path in &self.paths {
            let mut at = path.as_str();
            while let Some(slash) = at.rfind('/') {
                at = &at[..slash];
                if !dirs.insert(at.to_owned()) {
                    break;
                }
            }
        }
        dirs
    }
}

/// The part of a change that setup sees: its writes and deletes of key files that are not commit-only.
pub fn setup_change(change: &Change, key_files: &HashSet<String>, commit_only: &GlobSet) -> Change {
    let keeps = |path: &str| key_files.contains(path) && !commit_only.is_match(path);
    Change {
        files: change
            .files
            .iter()
            .filter(|file| keeps(file.path.as_str()))
            .cloned()
            .collect(),
        deleted: change
            .deleted
            .iter()
            .filter(|path| keeps(path.as_str()))
            .cloned()
            .collect(),
    }
}
