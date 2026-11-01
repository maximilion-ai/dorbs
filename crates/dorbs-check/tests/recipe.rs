//! Which recipe a repo gets: the operator's, the commit's, the repo's own commands, the adapter's.

use std::collections::HashMap;

use dorbs_check::adapter::{Adapters, Phase};
use dorbs_check::format::Format;
use dorbs_check::protocol::{Change, RelativePath};
use dorbs_check::recipe::{Recipe, resolve};
use dorbs_check::view::View;
use serde_json::json;

fn view(files: &[(&str, &str)], readable: impl Fn(&str) -> bool) -> View {
    let adapters = Adapters::load(None).unwrap();
    let paths = files
        .iter()
        .map(|(path, _)| RelativePath::try_from(*path).unwrap())
        .collect();
    let contents: HashMap<String, String> = (files.iter())
        .filter(|(path, _)| readable(path))
        .map(|(p, c)| ((*p).to_owned(), (*c).to_owned()))
        .collect();
    View::new(paths, contents, &Change::default(), &adapters.commit_only)
}

fn recipe_with(files: &[(&str, &str)], operator: Option<&str>) -> Result<Recipe, String> {
    let adapters = Adapters::load(None).unwrap();
    resolve(&adapters, &view(files, |_| true), operator, false)
}

fn recipe(files: &[(&str, &str)]) -> Recipe {
    recipe_with(files, None).unwrap()
}

fn setup(recipe: &Recipe) -> Vec<(String, String, Phase)> {
    recipe
        .setup
        .iter()
        .map(|s| (s.id.clone(), s.run.clone(), s.phase))
        .collect()
}

fn checks(recipe: &Recipe) -> Vec<(String, String)> {
    recipe
        .checks
        .iter()
        .map(|c| (c.id.to_string(), c.run.clone()))
        .collect()
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect()
}

const PNPM_LOCK: &str =
    "lockfileVersion: '9.0'\n\npackages:\n\n  typescript@5.9.3:\n    resolution: {}\n";

#[test]
fn installs_with_the_commits_pnpmfile_when_the_lockfile_records_its_checksum() {
    let manifest = json!({ "packageManager": "pnpm@12.14.0" }).to_string();
    let lock = format!("{PNPM_LOCK}\npnpmfileChecksum: sha256-x\n");
    let recipe = recipe(&[
        ("package.json", &manifest),
        ("pnpm-lock.yaml", &lock),
        (".pnpmfile.cjs", "module.exports = { hooks: {} };\n"),
    ]);
    assert_eq!(
        setup(&recipe),
        vec![
            ("download".into(), "pnpm fetch".into(), Phase::Online),
            (
                "install".into(),
                "pnpm install --offline --frozen-lockfile --ignore-scripts".into(),
                Phase::Offline
            ),
        ]
    );
}

#[test]
fn runs_a_pnpm_repos_own_typecheck_and_lint_scripts_after_a_frozen_install() {
    let manifest = json!({
        "packageManager": "pnpm@11.28.6",
        "scripts": { "typecheck": "tsc -p tsconfig.check.json --noEmit", "lint": "oxlint", "check": "x" },
        "devDependencies": { "vitest": "5.0.0" },
    })
    .to_string();
    let recipe = recipe(&[
        ("package.json", &manifest),
        ("pnpm-lock.yaml", PNPM_LOCK),
        ("pnpm-workspace.yaml", "packages:\n  - packages/*\n"),
        ("packages/a/package.json", r#"{"name":"a"}"#),
        ("tsconfig.json", "{}"),
        ("src/index.ts", ""),
    ]);
    assert_eq!(recipe.adapter, "node");
    assert_eq!(
        setup(&recipe),
        vec![
            (
                "download".into(),
                "pnpm fetch --ignore-pnpmfile".into(),
                Phase::Online
            ),
            (
                "install".into(),
                "pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile"
                    .into(),
                Phase::Offline
            ),
        ]
    );
    // The check script is left out: the typecheck script covers the types.
    assert_eq!(
        checks(&recipe),
        pairs(&[
            ("typecheck", "pnpm run typecheck"),
            (
                "lint",
                "pnpm exec oxlint --format github --no-error-on-unmatched-pattern {changed}"
            )
        ])
    );
    let test = recipe.test.unwrap();
    assert_eq!(
        test.run,
        "cd {dir} && pnpm exec vitest run --reporter=default --reporter=junit --outputFile.junit={report} {files} {filter}"
    );
    assert_eq!(
        (test.packages, test.filter_flag, test.format),
        (
            Some(vec![".".into(), "packages/a".into()]),
            Some("-t".into()),
            Format::Junit
        )
    );
}

#[test]
fn falls_back_to_the_check_script_or_check_type_without_a_typecheck_script() {
    let svelte = recipe(&[
        ("package.json", r#"{"scripts":{"check":"svelte-check"}}"#),
        ("pnpm-lock.yaml", PNPM_LOCK),
        ("tsconfig.json", "{}"),
    ]);
    assert_eq!(checks(&svelte), pairs(&[("check", "pnpm run check")]));
    let turbo = recipe(&[
        (
            "package.json",
            r#"{"scripts":{"check":"everything","check:type":"turbo typecheck"}}"#,
        ),
        ("pnpm-lock.yaml", PNPM_LOCK),
    ]);
    assert_eq!(
        checks(&turbo),
        pairs(&[("typecheck", "pnpm run check:type")])
    );
}

#[test]
fn adds_tsc_beside_a_check_script_that_runs_no_type_checker() {
    let recipe = recipe(&[
        (
            "package.json",
            r#"{"scripts":{"check":"vp check","lint":"vp lint src"}}"#,
        ),
        ("pnpm-lock.yaml", PNPM_LOCK),
        ("tsconfig.json", r#"{"compilerOptions":{"strict":true}}"#),
    ]);
    assert_eq!(
        checks(&recipe),
        pairs(&[
            ("lint", "pnpm run lint"),
            ("check", "pnpm run check"),
            (
                "typecheck",
                "pnpm exec tsc --noEmit -p tsconfig.json --pretty false"
            ),
        ])
    );
}

#[test]
fn runs_tsc_b_for_project_references_and_eslint_without_scripts() {
    let recipe = recipe(&[
        (
            "package.json",
            r#"{"workspaces":["packages/*"],"devDependencies":{"eslint":"9"}}"#,
        ),
        (
            "package-lock.json",
            r#"{"packages":{"node_modules/typescript":{"version":"6.0.2"}}}"#,
        ),
        (
            "tsconfig.json",
            r#"{"files":[],"references":[{"path":"packages/a"}]}"#,
        ),
        ("eslint.config.js", "export default [];"),
    ]);
    assert_eq!(
        setup(&recipe),
        vec![
            (
                "download".into(),
                "npm ci --ignore-scripts --no-audit --no-fund".into(),
                Phase::Online
            ),
            (
                "install".into(),
                "npm ci --offline --ignore-scripts --no-audit --no-fund".into(),
                Phase::Offline
            ),
        ]
    );
    assert_eq!(
        checks(&recipe),
        pairs(&[
            ("typecheck", "node_modules/.bin/tsc -b --pretty false"),
            ("lint", "node_modules/.bin/eslint .")
        ])
    );
}

#[test]
fn tells_yarn_classic_from_berry_and_gives_legacy_eslint_the_typescript_extensions() {
    let classic = recipe(&[
        ("package.json", r#"{"packageManager":"yarn@1.22.22"}"#),
        (
            "yarn.lock",
            "# yarn lockfile v1\n\ntypescript@5.9.3:\n  version \"5.9.3\"\n",
        ),
        ("tsconfig.json", "{}"),
        (".eslintrc.json", "{}"),
    ]);
    let runs: Vec<String> = setup(&classic)
        .into_iter()
        .map(|s| s.1)
        .chain(checks(&classic).into_iter().map(|c| c.1))
        .collect();
    assert_eq!(
        runs,
        vec![
            "yarn install --frozen-lockfile --ignore-scripts --non-interactive",
            "yarn install --offline --frozen-lockfile --ignore-scripts --non-interactive",
            "yarn tsc --noEmit -p tsconfig.json --pretty false",
            "yarn eslint . --ext .js,.jsx,.ts,.tsx,.mjs,.cjs,.mts,.cts",
        ]
    );
    let berry = recipe(&[
        ("package.json", r#"{"scripts":{"lint":"eslint ."}}"#),
        ("yarn.lock", "__metadata:\n  version: 8\n"),
        (".yarnrc.yml", "yarnPath: .yarn/releases/yarn-4.5.0.cjs\n"),
    ]);
    assert_eq!(
        setup(&berry).into_iter().map(|s| s.1).collect::<Vec<_>>(),
        vec![
            "yarn install --immutable --mode=skip-build",
            "YARN_ENABLE_NETWORK=0 yarn install --immutable --mode=skip-build"
        ]
    );
    assert_eq!(checks(&berry), pairs(&[("lint", "yarn run lint")]));
}

#[test]
fn installs_a_bun_repo_with_bun_and_runs_its_test_script() {
    let recipe = recipe(&[
        ("package.json", r#"{"scripts":{"test":"bun test"}}"#),
        (
            "bun.lock",
            r#"{ "packages": { "typescript": ["typescript@5.9.3", ""] } }"#,
        ),
        ("tsconfig.json", "{}"),
    ]);
    assert_eq!(
        setup(&recipe).into_iter().map(|s| s.1).collect::<Vec<_>>(),
        vec![
            "bun install --frozen-lockfile --ignore-scripts",
            "bun install --offline --frozen-lockfile --ignore-scripts"
        ]
    );
    assert_eq!(
        checks(&recipe),
        pairs(&[(
            "typecheck",
            "node_modules/.bin/tsc --noEmit -p tsconfig.json --pretty false"
        )])
    );
    let test = recipe.test.unwrap();
    assert_eq!(
        (test.run.as_str(), test.filter_flag, test.format),
        ("bun run test {files}", None, Format::Raw)
    );
}

#[test]
fn syncs_each_sveltekit_workspace_package_offline_after_the_install() {
    let recipe = recipe(&[
        ("package.json", r#"{"scripts":{"check":"pnpm -r check"}}"#),
        ("pnpm-lock.yaml", PNPM_LOCK),
        (
            "pnpm-workspace.yaml",
            "packages:\n  - 'sites/*'\n  - '!sites/old'\n",
        ),
        (
            "sites/docs/package.json",
            r#"{"devDependencies":{"@sveltejs/kit":"2"}}"#,
        ),
        (
            "sites/old/package.json",
            r#"{"devDependencies":{"@sveltejs/kit":"1"}}"#,
        ),
        (
            "fixtures/kit/package.json",
            r#"{"devDependencies":{"@sveltejs/kit":"2"}}"#,
        ),
    ]);
    let synced: Vec<_> = recipe.setup[2..]
        .iter()
        .map(|s| (s.id.as_str(), s.run.as_str(), s.cwd.as_str(), s.phase))
        .collect();
    assert_eq!(
        synced,
        vec![(
            "svelte-kit sync sites/docs",
            "pnpm exec svelte-kit sync",
            "sites/docs",
            Phase::Offline
        )]
    );
}

#[test]
fn runs_node_test_with_the_scripts_flags_and_a_workspaces_tests_per_package() {
    let node = recipe(&[
        (
            "package.json",
            r#"{"scripts":{"test":"node --experimental-strip-types --test src/**/*.test.ts"}}"#,
        ),
        ("package-lock.json", "{}"),
    ]);
    let test = node.test.unwrap();
    assert_eq!(
        test.run,
        "node --experimental-strip-types --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap --test-reporter-destination={report} {files} {filter}"
    );
    assert_eq!(
        (test.filter_flag.as_deref(), test.format),
        (Some("--test-name-pattern"), Format::Tap)
    );
    let workspace = recipe(&[
        (
            "package.json",
            r#"{"workspaces":["apps/*"],"scripts":{"test":"npm test --workspaces"}}"#,
        ),
        ("package-lock.json", "{}"),
        (
            "apps/web/package.json",
            r#"{"scripts":{"test":"node test.js"}}"#,
        ),
    ]);
    let test = workspace.test.unwrap();
    assert_eq!(
        (test.run.as_str(), test.packages),
        (
            "npm test -w {dir} -- {files}",
            Some(vec![".".into(), "apps/web".into()])
        )
    );
}

#[test]
fn syncs_a_uv_project_and_runs_the_type_checker_linter_and_pytest_it_locks() {
    let recipe = recipe(&[
        (
            "pyproject.toml",
            "[project]\nname = \"x\"\n[tool.uv.workspace]\nmembers = [\"libs/*\"]\n",
        ),
        ("libs/a/pyproject.toml", "[project]\nname = \"a\"\n"),
        (
            "uv.lock",
            "name = \"pyright\"\nname = \"ruff\"\nname = \"pytest\"\n",
        ),
        (".python-version", "3.12\n"),
    ]);
    let flags = "--frozen --all-extras --all-groups --all-packages";
    assert_eq!(recipe.adapter, "python");
    assert_eq!(
        setup(&recipe),
        vec![
            (
                "download".into(),
                format!("uv sync {flags} --no-install-local"),
                Phase::Online
            ),
            (
                "build backends".into(),
                format!("uv sync {flags} >/dev/null 2>&1 || true"),
                Phase::Online
            ),
            (
                "pyright".into(),
                ".venv/bin/pyright --version".into(),
                Phase::Online
            ),
            (
                "install".into(),
                format!("uv sync --offline {flags}"),
                Phase::Offline
            ),
        ]
    );
    assert_eq!(
        checks(&recipe),
        pairs(&[
            ("typecheck", ".venv/bin/pyright"),
            ("lint", ".venv/bin/ruff check --output-format sarif .")
        ])
    );
    assert_eq!(recipe.checks[1].format, Format::Sarif);
    let test = recipe.test.unwrap();
    assert_eq!(
        test.run,
        ".venv/bin/python -m pytest -q -p no:cacheprovider --junitxml={report} {files} {filter}"
    );
}

#[test]
fn installs_requirements_files_into_a_venv_and_prefers_basedpyright() {
    let recipe = recipe(&[
        ("package.json", r#"{"name":"web-client"}"#),
        ("requirements.txt", "flask==3\n"),
        ("requirements-dev.txt", "basedpyright==1.40.2\npyright==1\n"),
        ("go.mod", "module x\n"),
    ]);
    assert_eq!(recipe.adapter, "python");
    assert_eq!(
        setup(&recipe).into_iter().map(|s| s.0).collect::<Vec<_>>(),
        vec!["download", "pyright", "install"]
    );
    assert_eq!(
        checks(&recipe),
        pairs(&[("typecheck", ".venv/bin/basedpyright")])
    );
}

#[test]
fn checks_a_cargo_workspace_offline_and_filters_its_tests_by_name() {
    let recipe = recipe(&[
        ("Cargo.toml", "[workspace]\nmembers = [\"axum\"]\n"),
        ("Cargo.lock", ""),
        ("axum/Cargo.toml", "[package]\nname = \"axum\"\n"),
    ]);
    assert_eq!(
        setup(&recipe),
        vec![("fetch".into(), "cargo fetch --locked".into(), Phase::Online)]
    );
    assert_eq!(
        checks(&recipe),
        pairs(&[(
            "typecheck",
            "cargo check --workspace --all-targets --offline --locked --message-format short"
        )])
    );
    let test = recipe.test.unwrap();
    assert_eq!(
        (test.run.as_str(), test.filter_flag.as_deref()),
        (
            "cargo test --workspace --offline --locked {filter}",
            Some("")
        )
    );
}

#[test]
fn builds_and_vets_a_go_module_and_tests_the_packages_of_the_files() {
    let recipe = recipe(&[("go.mod", "module github.com/cli/cli/v2\n"), ("go.sum", "")]);
    assert_eq!(
        checks(&recipe),
        pairs(&[("typecheck", "go build ./..."), ("lint", "go vet ./...")])
    );
    let test = recipe.test.unwrap();
    assert_eq!(
        (test.run.as_str(), test.all.as_str()),
        ("go test -v {dirs} {filter}", "./...")
    );
}

#[test]
fn lets_the_commit_recipe_replace_parts_and_the_operator_replace_the_commit() {
    let commit = json!({
        "setup": [
            { "id": "download", "run": "npm ci --legacy-peer-deps --ignore-scripts", "phase": "online" },
            { "id": "build", "run": "npm run build" },
        ],
        "checks": [{ "id": "tsc", "run": "npx tsc -b packages" }],
        "test": null,
    })
    .to_string();
    let files = [
        (
            "package.json",
            r#"{"scripts":{"lint":"oxlint","test":"vitest"}}"#,
        ),
        ("package-lock.json", "{}"),
        (".dorbs/check.json", commit.as_str()),
    ];
    let recipe = recipe(&files);
    assert_eq!(
        setup(&recipe),
        vec![
            (
                "download".into(),
                "npm ci --legacy-peer-deps --ignore-scripts".into(),
                Phase::Online
            ),
            ("build".into(), "npm run build".into(), Phase::Offline),
        ]
    );
    // A step that names no key files has the adapter's for its phase, so its download sees the manifests.
    assert!(
        recipe.setup[0]
            .key
            .contains(&"package-lock.json".to_owned())
    );
    assert_eq!(checks(&recipe), pairs(&[("tsc", "npx tsc -b packages")]));
    assert!(
        matches!(recipe.checks[0].format, Format::Errorformat(ref patterns) if !patterns.is_empty())
    );
    assert_eq!(recipe.test, None);
    let operator =
        json!({ "checks": [{ "id": "lint", "run": "npm run lint", "format": "raw" }] }).to_string();
    let recipe = recipe_with(&files, Some(&operator)).unwrap();
    assert_eq!(checks(&recipe), pairs(&[("lint", "npm run lint")]));
    assert_eq!(setup(&recipe)[1].0, "build");
}

#[test]
fn gives_a_step_the_network_and_the_source_at_once_only_from_the_operator() {
    let file = json!({ "setup": [{ "id": "codegen", "run": "npm run codegen", "phase": "online-with-source" }] }).to_string();
    assert_eq!(
        recipe_with(&[("package.json", "{}"), (".dorbs/check.json", &file)], None),
        Err(".dorbs/check.json: a step with phase online-with-source comes only from the operator's registration.".into())
    );
    let recipe = recipe_with(&[("package.json", "{}")], Some(&file)).unwrap();
    assert_eq!(
        setup(&recipe),
        vec![(
            "codegen".into(),
            "npm run codegen".into(),
            Phase::OnlineWithSource
        )]
    );
}

#[test]
fn lets_a_commit_narrow_what_an_online_step_sees_but_never_widen_it() {
    let narrow = json!({ "setup": [{ "id": "download", "run": "npm ci", "phase": "online", "key": ["package-lock.json"] }] }).to_string();
    let recipe = recipe(&[
        ("package.json", "{}"),
        ("package-lock.json", "{}"),
        (".dorbs/check.json", &narrow),
    ]);
    assert_eq!(recipe.setup[0].key, vec!["package-lock.json"]);
    for (key, stubs) in [
        (json!(["**/*"]), json!([])),
        (json!(["package.json"]), json!(["src/**"])),
    ] {
        let wide = json!({ "setup": [{ "id": "download", "run": "npm ci", "phase": "online", "key": key, "stubs": stubs }] }).to_string();
        let refused = recipe_with(
            &[("package.json", "{}"), (".dorbs/check.json", &wide)],
            None,
        )
        .unwrap_err();
        assert!(refused.starts_with(".dorbs/check.json: the online step download may see only the node adapter's online files"), "{refused}");
        // The operator decides what its registration's steps see.
        assert!(recipe_with(&[("package.json", "{}")], Some(&wide)).is_ok());
    }
}

#[test]
fn says_why_when_no_adapter_runs_the_repo_or_the_recipe_file_does_not_parse() {
    let none = recipe_with(&[("README.md", "")], None).unwrap_err();
    assert!(
        none.starts_with("No adapter (node, python, ") && none.contains(") detects this repo"),
        "{none}"
    );
    let old = json!({ "checks": [{ "id": "x", "run": "x", "scope": "changed" }] }).to_string();
    let broken = recipe_with(&[("go.mod", ""), (".dorbs/check.json", &old)], None).unwrap_err();
    assert!(
        broken.starts_with(".dorbs/check.json: unknown field `scope`"),
        "{broken}"
    );
    let unknown = recipe_with(&[("go.mod", "")], Some(r#"{"image":"cobol"}"#)).unwrap_err();
    assert_eq!(unknown, "No adapter is named cobol.");
}

#[test]
fn reads_repo_commands_from_justfile_mise_and_makefile_where_the_host_runs_them() {
    let files = [
        ("go.mod", "module x\n"),
        (
            "Makefile",
            ".PHONY: lint test\nlint:\n\tgolangci-lint run\ntest:\n\tgo test ./...\n",
        ),
        (
            "justfile",
            "typecheck *args:\n    go build ./... {{args}}\n",
        ),
        (
            "mise.toml",
            "[tasks.test]\nrun = \"go test ./...\"\n[tasks.check]\nrun = \"go vet ./...\"\n",
        ),
    ];
    let adapters = Adapters::load(None).unwrap();
    // The go image runs none of these, so in the service the adapter's checks stay.
    let service = resolve(&adapters, &view(&files, |_| true), None, false).unwrap();
    assert_eq!(
        checks(&service),
        pairs(&[("typecheck", "go build ./..."), ("lint", "go vet ./...")])
    );
    let local = resolve(&adapters, &view(&files, |_| true), None, true).unwrap();
    // A check command beside a typecheck one is left out, as it would type-check twice.
    assert_eq!(
        checks(&local),
        pairs(&[("typecheck", "just typecheck"), ("lint", "make lint")])
    );
    // mise comes before make, and neither passes files on.
    assert_eq!(local.test.unwrap().run, "mise run test");
}

#[test]
fn resolves_the_same_recipe_from_only_the_files_the_adapters_read() {
    let adapters = Adapters::load(None).unwrap();
    let files = [
        (
            "package.json",
            r#"{"workspaces":["packages/*"],"scripts":{"typecheck":"tsc"},"devDependencies":{"vitest":"1"}}"#,
        ),
        (
            "packages/a/package.json",
            r#"{"name":"a","devDependencies":{"@sveltejs/kit":"2"}}"#,
        ),
        ("packages/a/src/index.ts", "export {}"),
        ("tsconfig.json", "{}"),
        ("pnpm-lock.yaml", PNPM_LOCK),
        ("patches/x.patch", ""),
        ("node_modules/x/package.json", "{}"),
    ];
    let all = resolve(&adapters, &view(&files, |_| true), None, false).unwrap();
    let read = resolve(
        &adapters,
        &view(&files, |path| adapters.reads.is_match(path)),
        None,
        false,
    )
    .unwrap();
    assert_eq!(all, read);
    assert!(!adapters.reads.is_match("packages/a/src/index.ts"));
    assert!(adapters.reads.is_match("packages/a/package.json"));
}

#[test]
fn seeds_and_keeps_vite_plus_caches_only_where_the_repo_uses_vite_plus() {
    let vite_plus = recipe(&[
        (
            "package.json",
            r#"{"packageManager":"pnpm@10.0.0","devDependencies":{"vite-plus":"1.4.0"}}"#,
        ),
        ("pnpm-lock.yaml", PNPM_LOCK),
    ]);
    assert_eq!(
        setup(&vite_plus)[1],
        (
            "vite-plus package manager".to_owned(),
            "pnpm install --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --filter . \
             && node_modules/.bin/vp exec true"
                .to_owned(),
            Phase::Online
        )
    );
    assert_eq!(vite_plus.warm, ["node_modules/.vite/task-cache"]);
    let plain = recipe(&[
        ("package.json", r#"{"packageManager":"pnpm@10.0.0"}"#),
        ("pnpm-lock.yaml", PNPM_LOCK),
    ]);
    assert!(
        setup(&plain)
            .iter()
            .all(|(id, _, _)| id != "vite-plus package manager")
    );
    assert!(plain.warm.is_empty());
}

#[test]
fn lints_only_the_changed_files_when_the_repos_lint_covers_the_whole_repo() {
    let lint = |script: &str| {
        let manifest = json!({ "packageManager": "pnpm@10.0.0", "scripts": { "lint": script } });
        let recipe = recipe(&[
            ("package.json", &manifest.to_string()),
            ("pnpm-lock.yaml", PNPM_LOCK),
        ]);
        let lint = recipe
            .checks
            .iter()
            .find(|check| check.id.as_str() == "lint");
        lint.map(|check| check.run.clone()).unwrap_or_default()
    };
    assert_eq!(
        lint("vp lint --deny-warnings --report-unused-disable-directives"),
        "pnpm exec vp lint --deny-warnings --report-unused-disable-directives --format github \
         --no-error-on-unmatched-pattern {changed}"
    );
    for whole in [
        "oxlint src",
        "oxlint --fix",
        "vp lint --format unix",
        "eslint .",
    ] {
        assert_eq!(lint(whole), "pnpm run lint", "{whole}");
    }
}
