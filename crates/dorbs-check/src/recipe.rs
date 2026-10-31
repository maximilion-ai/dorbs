//! A repo's recipe: how to set it up, check it and test it. Four layers make it, the first that
//! says something winning: the operator's registration, the commit's .dorbs/check.json, the repo's
//! own commands, and the adapter's defaults, which fill only the gaps the others leave.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};

use crate::adapter::{Adapter, Adapters, Glob, Phase, Role, Scope};
use crate::format::Format;
use crate::protocol::{CheckId, RelativePath};
use crate::repo_commands::{self, Part, RepoCommand};
use crate::view::{RECIPE_FILE, View};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupStep {
    pub id: String,
    pub run: String,
    pub cwd: String,
    pub phase: Phase,
    /// Globs of the files the step depends on, which key the environment.
    pub key: Vec<String>,
    /// Globs of the files an online step gets empty.
    pub stubs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Check {
    pub id: CheckId,
    /// May name `{changed}`, the changed files under `cwd`, and `{report}`, a file to write the report to.
    pub run: String,
    pub cwd: String,
    pub format: Format,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Test {
    /// May name `{files}`, `{dirs}`, `{filter}`, `{dir}` and `{report}`.
    pub run: String,
    pub cwd: String,
    /// The workspace's packages, when the test runs once per package of its files.
    pub packages: Option<Vec<String>>,
    pub filter_flag: Option<String>,
    pub all: String,
    pub format: Format,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Recipe {
    /// The adapter whose image and output settings the recipe uses.
    pub adapter: String,
    /// The adapter's container environment.
    pub env: BTreeMap<String, String>,
    pub setup: Vec<SetupStep>,
    pub checks: Vec<Check>,
    pub test: Option<Test>,
    /// Where each part came from, for the operator's log.
    #[serde(skip)]
    pub notes: Vec<String>,
}

/// Whose recipe file a layer is: only the operator's may give a step the network and the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Author {
    Operator,
    Commit,
}

/// .dorbs/check.json, or the `recipe` of an operator's registration: each field given replaces
/// what the layers below would give.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecipeFile {
    /// The adapter whose image runs the repo, which then fills the gaps.
    pub image: Option<String>,
    pub setup: Option<Vec<StepFile>>,
    pub checks: Option<Vec<CheckFile>>,
    /// null says the repo has no tests.
    #[serde(default, deserialize_with = "present")]
    pub test: Option<Option<TestFile>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepFile {
    pub id: String,
    pub run: String,
    pub cwd: Option<Cwd>,
    pub phase: Option<Phase>,
    /// The adapter's key files for the step's phase when absent.
    pub key: Option<Vec<Glob>>,
    pub stubs: Option<Vec<Glob>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckFile {
    pub id: CheckId,
    pub run: String,
    pub cwd: Option<Cwd>,
    pub format: Option<String>,
    pub errorformat: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TestFile {
    pub run: String,
    pub cwd: Option<Cwd>,
    #[serde(default)]
    pub per_package: bool,
    pub filter_flag: Option<String>,
    #[serde(default)]
    pub all: String,
    pub format: Option<String>,
}

/// A directory under the repo root, "." for the root.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(try_from = "String")]
pub struct Cwd(String);

impl TryFrom<String> for Cwd {
    type Error = String;
    fn try_from(value: String) -> Result<Self, String> {
        if value == "." {
            Ok(Cwd(value))
        } else {
            RelativePath::try_from(value).map(|path| Cwd(path.into()))
        }
    }
}

fn cwd(cwd: &Option<Cwd>) -> String {
    cwd.as_ref()
        .map_or_else(|| ".".to_owned(), |cwd| cwd.0.clone())
}

/// Tells a field set to null from one left out.
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// What the adapter offers one repo, its conditions and templates resolved.
#[derive(Debug, Clone)]
pub struct Defaults {
    pub adapter: String,
    pub env: BTreeMap<String, String>,
    pub setup: Vec<SetupStep>,
    pub checks: Vec<DefaultCheck>,
    /// The first runner test whose condition holds, which stands in for the repo's test command.
    pub runner: Option<Test>,
    pub test: Option<Test>,
    /// How the image runs a repo command, by source key, `{name}` naming the command.
    pub commands: BTreeMap<String, String>,
    pub errorformat: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DefaultCheck {
    pub check: Check,
    pub role: Option<Role>,
    pub covered_by: Option<regex::Regex>,
}

/// A layer of the recipe from a recipe file, resolved against the adapter it runs with.
#[derive(Debug, Clone, Default)]
pub struct Layer {
    pub setup: Option<Vec<SetupStep>>,
    pub checks: Option<Vec<Check>>,
    pub test: Option<Option<Test>>,
}

/// The recipe: for setup, checks and test, the operator's, else the commit's, else the repo's own
/// commands with the adapter's defaults filling the parts they leave.
pub fn merge(
    operator: &Layer,
    commit: &Layer,
    repo: &[RepoCommand],
    defaults: &Defaults,
) -> Recipe {
    let mut notes = Vec::new();
    let mut pick = |part: &str, operator_has: bool, commit_has: bool| {
        if operator_has {
            notes.push(format!("{part} from the operator's registration"));
        } else if commit_has {
            notes.push(format!("{part} from {RECIPE_FILE}"));
        }
    };
    pick("setup", operator.setup.is_some(), commit.setup.is_some());
    pick("checks", operator.checks.is_some(), commit.checks.is_some());
    pick("test", operator.test.is_some(), commit.test.is_some());
    let setup = (operator.setup.clone().or_else(|| commit.setup.clone()))
        .unwrap_or_else(|| defaults.setup.clone());
    let checks = (operator.checks.clone().or_else(|| commit.checks.clone()))
        .unwrap_or_else(|| merge_checks(repo, defaults, &mut notes));
    let test = (operator.test.clone().or_else(|| commit.test.clone())).unwrap_or_else(|| {
        let own = repo
            .iter()
            .find(|command| command.part == Part::Test)
            .and_then(|command| repo_test(command, defaults));
        defaults
            .runner
            .clone()
            .or(own)
            .or_else(|| defaults.test.clone())
    });
    Recipe {
        adapter: defaults.adapter.clone(),
        env: defaults.env.clone(),
        setup,
        checks,
        test,
        notes,
    }
}

fn merge_checks(repo: &[RepoCommand], defaults: &Defaults, notes: &mut Vec<String>) -> Vec<Check> {
    let has_typecheck = repo.iter().any(|c| c.part == Part::Check(Role::Typecheck));
    let own: Vec<(&RepoCommand, Role, &String)> = repo
        .iter()
        .filter_map(|command| match command.part {
            // A check command that only formats or lints leaves the type check to the adapter.
            Part::Check(Role::Check) if has_typecheck => None,
            Part::Check(role) => {
                Some((command, role, defaults.commands.get(command.source.key())?))
            }
            Part::Test => None,
        })
        .collect();
    let mut checks: Vec<Check> = own
        .iter()
        .map(|(command, role, runner)| {
            notes.push(format!(
                "{} from {} {}",
                role.name(),
                command.source.key(),
                command.name
            ));
            Check {
                id: CheckId::try_from(role.name()).expect("a role is a check id"),
                run: runner.replace("{name}", &command.name),
                cwd: ".".to_owned(),
                format: Format::Errorformat(defaults.errorformat.clone()),
            }
        })
        .collect();
    for default in &defaults.checks {
        let filled = default
            .role
            .is_some_and(|role| own.iter().any(|(_, r, _)| *r == role));
        let covered = (default.covered_by.as_ref()).is_some_and(|regex| {
            own.iter()
                .any(|(command, _, _)| regex.is_match(&command.body))
        });
        if filled || covered || checks.iter().any(|check| check.id == default.check.id) {
            continue;
        }
        notes.push(format!(
            "{} from the {} adapter",
            default.check.id, defaults.adapter
        ));
        checks.push(default.check.clone());
    }
    checks
}

/// The repo's test command as a test: files follow it when it takes arguments; it takes no filter.
fn repo_test(command: &RepoCommand, defaults: &Defaults) -> Option<Test> {
    let runner = defaults.commands.get(command.source.key())?;
    let run = runner.replace("{name}", &command.name);
    Some(Test {
        run: if command.takes_args {
            format!("{run} {{files}}")
        } else {
            run
        },
        cwd: ".".to_owned(),
        packages: None,
        filter_flag: None,
        all: String::new(),
        format: Format::Raw,
    })
}

/// The adapter's offer to the repo the scope sees.
pub fn defaults(scope: &Scope, local: bool) -> Result<Defaults, String> {
    let adapter = scope.adapter;
    let none = BTreeMap::new();
    let mut setup = Vec::new();
    for step in &adapter.setup {
        let mut captures = BTreeMap::new();
        if !scope.holds(&step.when, &mut captures) {
            continue;
        }
        let dirs: Vec<(String, BTreeMap<String, String>)> = match &step.each {
            None => vec![(".".to_owned(), captures)],
            Some(each) => (scope.packages().into_iter())
                .filter_map(|dir| {
                    Some((
                        dir.clone(),
                        scope.files_in(each, &dir).into_iter().next()?.1,
                    ))
                })
                .collect(),
        };
        for (dir, mut captures) in dirs {
            captures.insert("dir".to_owned(), dir.clone());
            setup.push(SetupStep {
                id: scope.expand(&step.id, &captures)?,
                run: scope.expand(&step.run, &captures)?,
                cwd: dir,
                phase: step.phase,
                key: step
                    .key
                    .iter()
                    .map(|glob| glob.as_str().to_owned())
                    .collect(),
                stubs: step
                    .stubs
                    .iter()
                    .map(|glob| glob.as_str().to_owned())
                    .collect(),
            });
        }
    }
    let mut checks = Vec::new();
    for def in &adapter.checks {
        let mut captures = BTreeMap::new();
        if !scope.holds(&def.when, &mut captures) {
            continue;
        }
        let id = CheckId::try_from(def.id.as_str())
            .map_err(|e| format!("adapter {}: {e}", adapter.name))?;
        checks.push(DefaultCheck {
            check: Check {
                id,
                run: scope.expand(&def.run, &captures)?,
                cwd: ".".to_owned(),
                format: scope.format(def.format.as_deref(), def.errorformat.as_ref())?,
            },
            role: def.role.or_else(|| Role::of(&def.id)),
            covered_by: def
                .covered_by
                .as_ref()
                .map(|pattern| pattern.regex().clone()),
        });
    }
    let mut runner = None;
    let mut test = None;
    for def in &adapter.tests {
        let slot = if def.runner { &mut runner } else { &mut test };
        let mut captures = BTreeMap::new();
        if slot.is_some() || !scope.holds(&def.when, &mut captures) {
            continue;
        }
        *slot = Some(Test {
            run: scope.expand(&def.run, &captures)?,
            cwd: ".".to_owned(),
            packages: def.per_package.then(|| scope.packages()),
            filter_flag: def.filter_flag.clone(),
            all: def.all.clone(),
            format: scope.format(def.format.as_deref(), None)?,
        });
    }
    let mut commands = BTreeMap::new();
    for (source, runner) in &adapter.commands {
        commands.insert(source.clone(), scope.expand(runner, &none)?);
    }
    if local {
        for source in [
            repo_commands::Source::Justfile,
            repo_commands::Source::Mise,
            repo_commands::Source::Makefile,
        ] {
            if let Some(runner) = source.local_runner() {
                commands
                    .entry(source.key().to_owned())
                    .or_insert_with(|| runner.to_owned());
            }
        }
    }
    Ok(Defaults {
        adapter: adapter.name.clone(),
        env: adapter.env.clone(),
        setup,
        checks,
        runner,
        test,
        commands,
        errorformat: adapter.output.errorformat.clone(),
    })
}

/// A recipe file as a layer over `defaults`.
pub fn layer(
    file: &RecipeFile,
    author: Author,
    scope: &Scope,
    defaults: &Defaults,
) -> Result<Layer, String> {
    let setup = match &file.setup {
        None => None,
        Some(steps) => Some(
            (steps.iter())
                .map(|step| {
                    let phase = step.phase.unwrap_or_default();
                    if phase == Phase::OnlineWithSource && author == Author::Commit {
                        return Err(format!(
                            "{RECIPE_FILE}: a step with phase online-with-source comes only from the operator's registration."
                        ));
                    }
                    let same = |p: Phase| (p == Phase::Offline) == (phase == Phase::Offline);
                    let adapter = |field: fn(&SetupStep) -> &Vec<String>| -> Vec<String> {
                        let globs: BTreeSet<&String> = defaults.setup.iter().filter(|s| same(s.phase)).flat_map(field).collect();
                        globs.into_iter().cloned().collect()
                    };
                    let given = |globs: &Option<Vec<Glob>>| -> Option<Vec<String>> {
                        globs.as_ref().map(|globs| globs.iter().map(|g| g.as_str().to_owned()).collect())
                    };
                    let key = given(&step.key).unwrap_or_else(|| adapter(|s| &s.key));
                    let stubs = given(&step.stubs).unwrap_or_else(|| adapter(|s| &s.stubs));
                    // What an online step sees has the network: a commit may narrow it, never widen it.
                    if author == Author::Commit && phase == Phase::Online {
                        let (allowed_key, allowed_stubs) = (adapter(|s| &s.key), adapter(|s| &s.stubs));
                        if let Some(glob) = (key.iter().find(|g| !allowed_key.contains(g)))
                            .or_else(|| stubs.iter().find(|g| !allowed_stubs.contains(g)))
                        {
                            return Err(format!(
                                "{RECIPE_FILE}: the online step {} may see only the {} adapter's online files, not {glob}.",
                                step.id, defaults.adapter
                            ));
                        }
                    }
                    Ok(SetupStep { id: step.id.clone(), run: step.run.clone(), cwd: cwd(&step.cwd), phase, key, stubs })
                })
                .collect::<Result<_, String>>()?,
        ),
    };
    let checks = match &file.checks {
        None => None,
        Some(checks) => Some(
            (checks.iter())
                .map(|check| {
                    Ok(Check {
                        id: check.id.clone(),
                        run: check.run.clone(),
                        cwd: cwd(&check.cwd),
                        format: scope
                            .format(check.format.as_deref(), check.errorformat.as_ref())?,
                    })
                })
                .collect::<Result<_, String>>()?,
        ),
    };
    let test = match &file.test {
        None => None,
        Some(None) => Some(None),
        Some(Some(test)) => Some(Some(Test {
            run: test.run.clone(),
            cwd: cwd(&test.cwd),
            packages: test.per_package.then(|| scope.packages()),
            filter_flag: test.filter_flag.clone(),
            all: test.all.clone(),
            format: scope.format(Some(test.format.as_deref().unwrap_or("raw")), None)?,
        })),
    };
    Ok(Layer {
        setup,
        checks,
        test,
    })
}

/// The recipe for the repo `view` shows, with the operator's recipe, if any. Among the adapters
/// that detect the repo, highest priority first, the first whose recipe has a check wins, else the
/// first; a recipe file that names an image picks that adapter.
pub fn resolve(
    adapters: &Adapters,
    view: &View,
    operator: Option<&str>,
    local: bool,
) -> Result<Recipe, String> {
    let parse = |text: &str, whose: &str| -> Result<RecipeFile, String> {
        serde_json::from_str(text).map_err(|e| format!("{whose}: {e}"))
    };
    let operator = operator
        .map(|text| parse(text, "the operator's recipe"))
        .transpose()?;
    let commit = view
        .read(RECIPE_FILE)
        .map(|text| parse(text, RECIPE_FILE))
        .transpose()?;
    let named = (operator.as_ref().and_then(|f| f.image.clone()))
        .or_else(|| commit.as_ref().and_then(|f| f.image.clone()));
    let candidates: Vec<&Adapter> = match &named {
        Some(name) => vec![
            adapters
                .get(name)
                .ok_or_else(|| format!("No adapter is named {name}."))?,
        ],
        None => adapters
            .list
            .iter()
            .filter(|adapter| adapter.detects(view))
            .collect(),
    };
    let repo = repo_commands::discover(view);
    let mut recipes = Vec::new();
    for adapter in candidates {
        let scope = Scope::new(adapter, view)?;
        let defaults = defaults(&scope, local)?;
        let layer = |file: &Option<RecipeFile>, author| {
            file.as_ref().map_or_else(
                || Ok(Layer::default()),
                |file| self::layer(file, author, &scope, &defaults),
            )
        };
        let recipe = merge(
            &layer(&operator, Author::Operator)?,
            &layer(&commit, Author::Commit)?,
            &repo,
            &defaults,
        );
        if !recipe.checks.is_empty() {
            return Ok(recipe);
        }
        recipes.push(recipe);
    }
    recipes.into_iter().next().ok_or_else(|| {
        format!(
            "No adapter ({}) detects this repo, and it has no {RECIPE_FILE} that names an image.",
            {
                adapters
                    .list
                    .iter()
                    .map(|a| a.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )
    })
}
