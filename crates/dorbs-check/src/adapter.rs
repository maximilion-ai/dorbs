//! Adapters: one TOML file per ecosystem that says how to detect it, which image runs it, how to set
//! it up, and which checks and tests fill the gaps the repo's own commands leave. The binary embeds
//! `adapters/`; `ADAPTERS_DIR` adds or replaces files by name.

use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::Path;

use globset::{GlobBuilder, GlobMatcher, GlobSet, GlobSetBuilder};
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Deserializer};

use crate::format::Format;
use crate::protocol::RelativePath;
use crate::view::{RECIPE_FILE, View};

include!(concat!(env!("OUT_DIR"), "/adapters.rs"));

/// A glob over repo paths: `*` stays within a directory, `**` crosses them.
#[derive(Clone)]
pub struct Glob(String, GlobMatcher);

impl Glob {
    pub fn new(glob: &str) -> Result<Self, String> {
        let matcher = (GlobBuilder::new(glob).literal_separator(true).build())
            .map_err(|e| format!("glob {glob:?}: {e}"))?
            .compile_matcher();
        Ok(Self(glob.to_owned(), matcher))
    }

    pub fn is_match(&self, path: &str) -> bool {
        self.1.is_match(path)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Glob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl<'de> Deserialize<'de> for Glob {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Glob::new(&String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A regex an adapter matches file content with; named groups become template names.
#[derive(Clone)]
pub struct Pattern(Regex);

impl fmt::Debug for Pattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0.as_str())
    }
}

impl Pattern {
    pub fn regex(&self) -> &Regex {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Pattern {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Regex::new(&text)
            .map(Pattern)
            .map_err(serde::de::Error::custom)
    }
}

fn one_or_many<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<Glob>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        One(Glob),
        Many(Vec<Glob>),
    }
    Ok(match OneOrMany::deserialize(deserializer)? {
        OneOrMany::One(glob) => vec![glob],
        OneOrMany::Many(globs) => globs,
    })
}

/// Some file matching `file` has content matching `regex`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contains {
    #[serde(deserialize_with = "one_or_many")]
    pub file: Vec<Glob>,
    pub regex: Pattern,
}

/// A condition on the repo. Every field given must hold; within `exists` and `contains` one match
/// is enough.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    /// Some path matches one of these.
    #[serde(default)]
    pub exists: Vec<Glob>,
    /// No path matches any of these.
    #[serde(default)]
    pub absent: Vec<Glob>,
    #[serde(default)]
    pub contains: Vec<Contains>,
    /// Template values, such as `"pm.name" = "pnpm"`, equal these.
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
    /// One of these holds.
    #[serde(default)]
    pub any: Vec<When>,
}

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, serde::Serialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// First, with the network through the egress proxy, in a tree of the steps' key files alone.
    Online,
    /// Then on the full tree without network.
    #[default]
    Offline,
    /// The network and the full tree at once, before the offline steps; only the operator may ask.
    OnlineWithSource,
}

/// The parts of the interface a repo command or a default check can fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Typecheck,
    Lint,
    Check,
}

impl Role {
    pub fn name(self) -> &'static str {
        match self {
            Role::Typecheck => "typecheck",
            Role::Lint => "lint",
            Role::Check => "check",
        }
    }

    pub fn of(id: &str) -> Option<Role> {
        [Role::Typecheck, Role::Lint, Role::Check]
            .into_iter()
            .find(|role| role.name() == id)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepDef {
    /// May name `{dir}` when the step runs once per directory of `each`.
    pub id: String,
    pub run: String,
    #[serde(default)]
    pub phase: Phase,
    /// The files the step depends on: they key the environment, and an online step sees only them.
    #[serde(default)]
    pub key: Vec<Glob>,
    /// Files the step needs to exist but must not read: an online step gets them empty.
    #[serde(default)]
    pub stubs: Vec<Glob>,
    #[serde(default)]
    pub when: When,
    /// Runs the step once in each workspace package whose files, relative to it, match.
    pub each: Option<Contains>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckDef {
    pub id: String,
    /// The part of the interface the check fills; its id when that names one.
    pub role: Option<Role>,
    pub run: String,
    #[serde(default)]
    pub when: When,
    /// A repo `check` command whose body matches this already does what this check would.
    pub covered_by: Option<Pattern>,
    pub format: Option<String>,
    pub errorformat: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestDef {
    /// Runs the runner the repo's own test command runs, with files and a filter, so it stands in
    /// for that command.
    #[serde(default)]
    pub runner: bool,
    pub run: String,
    #[serde(default)]
    pub when: When,
    /// Runs once per workspace package of the test files, from the package `{dir}` names.
    #[serde(default)]
    pub per_package: bool,
    /// The flag before a name filter: empty when it is positional; filters are refused without one.
    pub filter_flag: Option<String>,
    /// What `{files}` and `{dirs}` become when the request names no files.
    #[serde(default)]
    pub all: String,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    /// The patterns a check without a format of its own is read with.
    #[serde(default)]
    pub errorformat: Vec<String>,
    /// Prefixes that name the package directory a line comes from: `dir` or `package`, and `line`.
    #[serde(default)]
    pub prefixes: Vec<Pattern>,
    /// Where package names are, for `package` prefixes: the `name` group, in the file's directory.
    pub names: Option<Contains>,
}

/// A workspace's packages: the directories holding `manifest` that a member list names.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub manifest: String,
    #[serde(default)]
    pub members: Vec<Members>,
}

/// Globs of member directories in a file: `block`'s first group holds them, one per `item` match's
/// first group; a glob that starts with ! excludes.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Members {
    pub file: String,
    pub block: Pattern,
    pub item: Pattern,
}

/// A value an adapter's templates use, picked from options by their `when`.
#[derive(Debug, Clone, Deserialize)]
pub struct LetOption {
    #[serde(default)]
    pub when: When,
    #[serde(flatten)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Adapter {
    #[serde(skip)]
    pub name: String,
    /// Among the adapters that detect a repo, the highest priority goes first.
    #[serde(default)]
    pub priority: i32,
    /// The repo is this adapter's when a path matches one of these.
    pub detect: Vec<Glob>,
    /// Paths none of this adapter's globs see, such as installed dependencies.
    #[serde(default)]
    pub ignore: Vec<Glob>,
    /// Package manager files that can run code or redirect downloads: setup takes them from the
    /// commit, never from the change.
    #[serde(default)]
    pub commit_only: Vec<Glob>,
    /// The Dockerfile of the image every container of the adapter's environments runs.
    pub image: String,
    /// Environment variables of its containers: where the tools keep their caches, under /env/home.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The hosts its online setup steps download from, which the egress proxy lets through on 443.
    #[serde(default)]
    pub egress: Vec<String>,
    /// How the image runs a repo command, by source: `package.json`, `Makefile`, `justfile`,
    /// `mise.toml`, with `{name}` for the command. A source not listed is not run.
    #[serde(default)]
    pub commands: BTreeMap<String, String>,
    #[serde(default)]
    pub output: Output,
    pub workspace: Option<Workspace>,
    /// Each option list gives `{name.field}`: the first option whose `when` holds.
    #[serde(default, rename = "let")]
    pub lets: IndexMap<String, Vec<LetOption>>,
    #[serde(default)]
    pub setup: Vec<StepDef>,
    #[serde(default)]
    pub checks: Vec<CheckDef>,
    #[serde(default)]
    pub tests: Vec<TestDef>,
}

impl Adapter {
    pub fn parse(name: &str, text: &str) -> Result<Adapter, String> {
        let mut adapter: Adapter =
            toml::from_str(text).map_err(|e| format!("adapter {name}: {e}"))?;
        adapter.name = name.to_owned();
        Ok(adapter)
    }

    /// Whether this adapter's globs may see `path`.
    fn sees(&self, path: &str) -> bool {
        !self.ignore.iter().any(|glob| glob.is_match(path))
    }

    pub fn detects(&self, view: &View) -> bool {
        (view.paths().iter()).any(|p| self.sees(p) && self.detect.iter().any(|g| g.is_match(p)))
    }

    /// Every glob whose files' content this adapter reads.
    fn reads(&self) -> Vec<&Glob> {
        fn contains(when: &When) -> Vec<&Contains> {
            let mut found: Vec<&Contains> = when.contains.iter().collect();
            let mut nested: Vec<&When> = when.any.iter().collect();
            while let Some(when) = nested.pop() {
                found.extend(&when.contains);
                nested.extend(&when.any);
            }
            found
        }
        let mut whens: Vec<&When> = Vec::new();
        whens.extend(self.lets.values().flatten().map(|option| &option.when));
        whens.extend(self.setup.iter().map(|step| &step.when));
        whens.extend(self.checks.iter().map(|check| &check.when));
        whens.extend(self.tests.iter().map(|test| &test.when));
        let mut globs: Vec<&Glob> = whens
            .into_iter()
            .flat_map(contains)
            .flat_map(|c| &c.file)
            .collect();
        globs.extend(self.setup.iter().flat_map(|step| &step.key));
        globs.extend(self.output.names.iter().flat_map(|c| &c.file));
        globs
    }

    /// The globs, under any package, of the files `each` reads, and the workspace's member lists.
    fn reads_anywhere(&self) -> Vec<String> {
        let each = self
            .setup
            .iter()
            .flat_map(|step| step.each.iter().flat_map(|c| &c.file));
        let mut globs: Vec<String> = each
            .flat_map(|g| [g.as_str().to_owned(), format!("**/{}", g.as_str())])
            .collect();
        globs.extend(
            self.workspace
                .iter()
                .flat_map(|w| w.members.iter().map(|m| m.file.clone())),
        );
        globs
    }
}

/// The adapters the service knows, by name.
#[derive(Debug, Clone)]
pub struct Adapters {
    pub list: Vec<Adapter>,
    /// The files whose content any adapter or repo command source reads.
    pub reads: GlobSet,
    /// Every adapter's commit-only files and the recipe file.
    pub commit_only: GlobSet,
}

/// The files repo commands come from.
pub const COMMAND_SOURCES: [&str; 8] = [
    "package.json",
    "Makefile",
    "GNUmakefile",
    "makefile",
    "justfile",
    ".justfile",
    "mise.toml",
    ".mise.toml",
];

impl Adapters {
    /// The embedded adapters, with the files of `dir` added or replacing them by name.
    pub fn load(dir: Option<&Path>) -> Result<Adapters, String> {
        let mut texts: BTreeMap<String, String> = EMBEDDED
            .iter()
            .map(|(name, text)| ((*name).to_owned(), (*text).to_owned()))
            .collect();
        if let Some(dir) = dir {
            let entries = std::fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            for entry in entries {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.extension().is_some_and(|ext| ext == "toml") {
                    let name = path
                        .file_stem()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned();
                    let text = std::fs::read_to_string(&path)
                        .map_err(|e| format!("{}: {e}", path.display()))?;
                    texts.insert(name, text);
                }
            }
        }
        let list = texts
            .iter()
            .map(|(name, text)| Adapter::parse(name, text))
            .collect::<Result<Vec<_>, _>>()?;
        Adapters::new(list)
    }

    pub fn new(mut list: Vec<Adapter>) -> Result<Adapters, String> {
        list.sort_by(|a, b| {
            b.priority
                .cmp(&a.priority)
                .then_with(|| a.name.cmp(&b.name))
        });
        let set = |globs: Vec<&str>| -> Result<GlobSet, String> {
            let mut builder = GlobSetBuilder::new();
            for glob in globs {
                builder.add(
                    GlobBuilder::new(glob)
                        .literal_separator(true)
                        .build()
                        .map_err(|e| e.to_string())?,
                );
            }
            builder.build().map_err(|e| e.to_string())
        };
        let anywhere: Vec<String> = list.iter().flat_map(|a| a.reads_anywhere()).collect();
        let mut reads: Vec<&str> = COMMAND_SOURCES.to_vec();
        reads.push(RECIPE_FILE);
        reads.extend(list.iter().flat_map(|a| a.reads()).map(Glob::as_str));
        reads.extend(anywhere.iter().map(String::as_str));
        let mut commit_only: Vec<&str> = vec![RECIPE_FILE];
        commit_only.extend(list.iter().flat_map(|a| &a.commit_only).map(Glob::as_str));
        Ok(Adapters {
            reads: set(reads)?,
            commit_only: set(commit_only)?,
            list,
        })
    }

    pub fn get(&self, name: &str) -> Option<&Adapter> {
        self.list.iter().find(|adapter| adapter.name == name)
    }
}

/// What the templates of one adapter see for one repo: its lets' picked options.
pub struct Scope<'a> {
    pub adapter: &'a Adapter,
    pub view: &'a View,
    lets: HashMap<String, BTreeMap<String, String>>,
}

/// Names a template may leave for the run to fill.
const RUN_NAMES: [&str; 7] = [
    "files", "dirs", "filter", "dir", "report", "changed", "name",
];

impl<'a> Scope<'a> {
    pub fn new(adapter: &'a Adapter, view: &'a View) -> Result<Scope<'a>, String> {
        let mut scope = Scope {
            adapter,
            view,
            lets: HashMap::new(),
        };
        for (name, options) in &adapter.lets {
            let picked = options.iter().find_map(|option| {
                let mut captures = BTreeMap::new();
                scope.holds(&option.when, &mut captures).then(|| {
                    let mut fields = option.fields.clone();
                    fields.extend(captures);
                    fields
                })
            });
            if let Some(mut fields) = picked {
                for value in fields.values_mut() {
                    *value = scope.expand(value, &BTreeMap::new())?;
                }
                scope.lets.insert(name.clone(), fields);
            }
        }
        Ok(scope)
    }

    fn paths(&self) -> impl Iterator<Item = &'a RelativePath> + '_ {
        self.view
            .paths()
            .iter()
            .filter(|path| self.adapter.sees(path))
    }

    /// Whether `when` holds; the named groups of the `contains` regexes that matched go to `captures`.
    pub fn holds(&self, when: &When, captures: &mut BTreeMap<String, String>) -> bool {
        let any_path = |globs: &[Glob]| self.paths().any(|p| globs.iter().any(|g| g.is_match(p)));
        if !when.exists.is_empty() && !any_path(&when.exists) {
            return false;
        }
        if any_path(&when.absent) {
            return false;
        }
        if !when.contains.is_empty() && !when.contains.iter().any(|c| self.matches(c, captures)) {
            return false;
        }
        for (name, value) in &when.vars {
            if self.lookup(name).as_deref() != Some(value.as_str()) {
                return false;
            }
        }
        when.any.is_empty() || when.any.iter().any(|when| self.holds(when, captures))
    }

    fn matches(&self, contains: &Contains, captures: &mut BTreeMap<String, String>) -> bool {
        self.files(contains).first().is_some_and(|(_, caps)| {
            captures.extend(caps.clone());
            true
        })
    }

    /// The files matching `contains`, with their regex's named groups.
    pub fn files(&self, contains: &Contains) -> Vec<(&'a RelativePath, BTreeMap<String, String>)> {
        self.files_in(contains, ".")
    }

    /// The files under `dir` whose paths relative to it match `contains`, with the named groups.
    pub fn files_in(
        &self,
        contains: &Contains,
        dir: &str,
    ) -> Vec<(&'a RelativePath, BTreeMap<String, String>)> {
        let regex = &contains.regex.0;
        let prefix = if dir == "." {
            String::new()
        } else {
            format!("{dir}/")
        };
        self.paths()
            .filter(|path| {
                let Some(relative) = path.strip_prefix(prefix.as_str()) else {
                    return false;
                };
                contains.file.iter().any(|glob| glob.is_match(relative))
            })
            .filter_map(|path| {
                let caps = regex.captures(self.view.read(path)?)?;
                let named = (regex.capture_names().flatten())
                    .map(|name| {
                        (
                            name.to_owned(),
                            caps.name(name).map_or("", |m| m.as_str()).to_owned(),
                        )
                    })
                    .collect();
                Some((path, named))
            })
            .collect()
    }

    /// The workspace's package directories, the root first, then the members in order.
    pub fn packages(&self) -> Vec<String> {
        let mut packages = vec![".".to_owned()];
        let Some(workspace) = &self.adapter.workspace else {
            return packages;
        };
        let (mut include, mut exclude) = (Vec::new(), Vec::new());
        for list in &workspace.members {
            let Some(text) = self.view.read(&list.file) else {
                continue;
            };
            let Some(block) = list.block.0.captures(text).and_then(|caps| caps.get(1)) else {
                continue;
            };
            for item in list
                .item
                .0
                .captures_iter(block.as_str())
                .filter_map(|caps| caps.get(1))
            {
                let glob = item
                    .as_str()
                    .trim()
                    .trim_start_matches("./")
                    .trim_end_matches('/');
                match glob.strip_prefix('!') {
                    Some(glob) => exclude.extend(Glob::new(glob)),
                    None => include.extend(Glob::new(glob)),
                }
            }
        }
        let manifest = format!("/{}", workspace.manifest);
        let mut members: Vec<String> = (self.paths())
            .filter_map(|path| path.strip_suffix(manifest.as_str()))
            .filter(|dir| {
                include.iter().any(|g| g.is_match(dir)) && !exclude.iter().any(|g| g.is_match(dir))
            })
            .map(str::to_owned)
            .collect();
        members.sort();
        packages.extend(members);
        packages
    }

    /// How the adapter's output prefixes map to package directories in this repo.
    pub fn streams(&self) -> crate::format::Streams {
        let mut packages = HashMap::new();
        if let Some(contains) = &self.adapter.output.names {
            for (path, caps) in self.files(contains) {
                if let Some(name) = caps.get("name") {
                    let dir = path.rsplit_once('/').map_or(".", |(dir, _)| dir);
                    packages
                        .entry(name.clone())
                        .or_insert_with(|| dir.to_owned());
                }
            }
        }
        crate::format::Streams {
            prefixes: self
                .adapter
                .output
                .prefixes
                .iter()
                .map(|p| p.0.clone())
                .collect(),
            packages,
            dirs: self.view.dirs(),
        }
    }

    fn lookup(&self, name: &str) -> Option<String> {
        let (group, field) = name.split_once('.')?;
        self.lets.get(group)?.get(field).cloned()
    }

    /// `template` with `{let.field}` and `{capture}` filled in; the run's names stay for the run.
    pub fn expand(
        &self,
        template: &str,
        captures: &BTreeMap<String, String>,
    ) -> Result<String, String> {
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            let close = after.find('}');
            let name = close.map(|close| &after[..close]);
            let is_name = name.is_some_and(|n| {
                !n.is_empty()
                    && n.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            });
            // ${VAR} and anything else that is not a name is the shell's.
            if !is_name || out.ends_with('$') {
                out.push('{');
                rest = after;
                continue;
            }
            let (name, close) = (name.unwrap_or_default(), close.unwrap_or_default());
            if name.contains('.') {
                let value = self.lookup(name).ok_or_else(|| {
                    format!("adapter {}: {{{name}}} has no value", self.adapter.name)
                })?;
                out.push_str(&value);
            } else if let Some(value) = captures.get(name) {
                out.push_str(value);
            } else if RUN_NAMES.contains(&name) {
                out.push_str(&format!("{{{name}}}"));
            } else {
                return Err(format!(
                    "adapter {}: {{{name}}} names nothing",
                    self.adapter.name
                ));
            }
            rest = &after[close + 1..];
        }
        out.push_str(rest);
        Ok(out)
    }

    /// The format a check or test names, its errorformat patterns defaulting to the adapter's.
    pub fn format(
        &self,
        format: Option<&str>,
        errorformat: Option<&Vec<String>>,
    ) -> Result<Format, String> {
        let patterns = || {
            errorformat
                .cloned()
                .unwrap_or_else(|| self.adapter.output.errorformat.clone())
        };
        let format = match format {
            None | Some("errorformat") => Format::Errorformat(patterns()),
            Some("sarif") => Format::Sarif,
            Some("junit") => Format::Junit,
            Some("tap") => Format::Tap,
            Some("raw") => Format::Raw,
            Some(other) => {
                return Err(format!(
                    "unknown format {other:?}: sarif, errorformat, junit, tap or raw"
                ));
            }
        };
        format.validate()?;
        Ok(format)
    }
}
