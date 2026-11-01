//! dorbs-check: one check and test interface for any repo.
//!
//!   dorbs-check check [--dir DIR] [--only ID]... [--json]   the repo's checks, as diagnostics
//!   dorbs-check test [--dir DIR] [--filter PATTERN] [--json] [FILE]...
//!   dorbs-check recipe [--dir DIR]                          the recipe the checkout resolves to
//!   dorbs-check parse --adapter NAME [--format F] [--root DIR] [--cwd DIR] < output
//!                                                           a tool's output as diagnostics, as JSON
//!   dorbs-check serve                                       the HTTP service, configured by its environment
//!   dorbs-check egress                                      the setup network's proxy, in its container
//!
//! Exits 0 when everything passed, 1 when something failed, 2 when it could not run.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use dorbs_check::adapter::Adapters;
use dorbs_check::docker::Docker;
use dorbs_check::environments::{self, Environments};
use dorbs_check::local::Checkout;
use dorbs_check::protocol::{CheckId, CheckResult, RunStatus, Severity, TestResult};
use dorbs_check::service::Service;
use dorbs_check::{config, egress, format, http};

const USAGE: &str = "usage: dorbs-check check|test|recipe [--dir DIR] [--only ID] [--filter PATTERN] [--json] [FILE]... | parse --adapter NAME | serve | egress";

struct Args {
    command: String,
    dir: PathBuf,
    adapter: Option<String>,
    format: Option<String>,
    root: Option<String>,
    cwd: String,
    only: Vec<String>,
    filter: Option<String>,
    json: bool,
    files: Vec<String>,
}

fn parse(mut args: impl Iterator<Item = String>) -> Result<Args, String> {
    let command = args.next().ok_or(USAGE)?;
    let mut parsed = Args {
        command,
        dir: PathBuf::from("."),
        adapter: None,
        format: None,
        root: None,
        cwd: ".".to_owned(),
        only: vec![],
        filter: None,
        json: false,
        files: vec![],
    };
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--dir" => parsed.dir = PathBuf::from(value("--dir")?),
            "--only" => parsed
                .only
                .extend(value("--only")?.split(',').map(str::to_owned)),
            "--filter" => parsed.filter = Some(value("--filter")?),
            "--json" => parsed.json = true,
            "--adapter" => parsed.adapter = Some(value("--adapter")?),
            "--format" => parsed.format = Some(value("--format")?),
            "--root" => parsed.root = Some(value("--root")?),
            "--cwd" => parsed.cwd = value("--cwd")?,
            flag if flag.starts_with("--") => return Err(format!("unknown flag {flag}\n{USAGE}")),
            file => parsed.files.push(file.to_owned()),
        }
    }
    Ok(parsed)
}

fn main() -> ExitCode {
    let args = match parse(std::env::args().skip(1)) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let runtime = tokio::runtime::Runtime::new().expect("a tokio runtime");
    match runtime.block_on(run(args)) {
        Ok(passed) => ExitCode::from(if passed { 0 } else { 1 }),
        Err(error) => {
            eprintln!("dorbs-check: {error}");
            ExitCode::from(2)
        }
    }
}

async fn serve() -> Result<bool, String> {
    let settings = config::load()?;
    std::fs::create_dir_all(&settings.data_dir)
        .map_err(|e| format!("{}: {e}", settings.data_dir.display()))?;
    let docker = Arc::new(Docker::new(
        &settings.prefix,
        &settings.data_dir,
        settings.limits.clone(),
        settings.egress,
    ));
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    docker.start_egress(&settings.egress_allow, &exe).await?;
    let limits = environments::Limits {
        disk_budget: settings.disk_budget,
        idle_after: settings.idle_after,
        retry_setup_after: settings.retry_setup_after,
        setup_timeout: settings.setup_timeout,
        replicas: settings.replicas,
    };
    let environments = Environments::start(
        &settings.data_dir,
        docker.clone(),
        limits,
        settings.run_slots,
    )
    .await?;
    let address = format!("{}:{}", settings.host, settings.port);
    let service = Arc::new(Service::new(settings, docker, environments));
    let listener = tokio::net::TcpListener::bind(&address)
        .await
        .map_err(|e| format!("{address}: {e}"))?;
    dorbs_check::log(&format!("listening on http://{address}"));
    axum::serve(listener, http::router(service))
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

async fn egress() -> Result<bool, String> {
    let allow = egress::allow_list(&std::env::var("EGRESS_ALLOW").unwrap_or_default());
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3128")
        .await
        .map_err(|e| e.to_string())?;
    dorbs_check::log(&format!("egress proxy on :3128 for {}", allow.join(", ")));
    egress::serve(listener, allow, vec![443])
        .await
        .map_err(|e| e.to_string())?;
    Ok(true)
}

async fn run(args: Args) -> Result<bool, String> {
    match args.command.as_str() {
        "serve" => return serve().await,
        "egress" => return egress().await,
        _ => {}
    }
    let adapters = Adapters::load(
        std::env::var_os("ADAPTERS_DIR")
            .map(PathBuf::from)
            .as_deref(),
    )?;
    if args.command == "parse" {
        return parse_stdin(&adapters, &args);
    }
    match args.command.as_str() {
        "check" | "test" | "recipe" => {}
        other => return Err(format!("unknown command {other}\n{USAGE}")),
    }
    let checkout = Checkout::open(&args.dir, adapters)?;
    match args.command.as_str() {
        "recipe" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&checkout.recipe).expect("a recipe serializes")
            );
            for note in &checkout.recipe.notes {
                eprintln!("{note}");
            }
            Ok(true)
        }
        "check" => {
            let only = (!args.only.is_empty())
                .then(|| {
                    args.only
                        .iter()
                        .map(|id| CheckId::try_from(id.as_str()))
                        .collect::<Result<Vec<_>, _>>()
                })
                .transpose()?;
            let result = checkout.check(only.as_deref()).await?;
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).expect("a result serializes")
                );
            } else {
                print_check(&result);
            }
            Ok(result
                .checks
                .iter()
                .all(|run| matches!(run.status, RunStatus::Passed | RunStatus::Skipped)))
        }
        _ => {
            let result = checkout.test(&args.files, args.filter.as_deref()).await?;
            if args.json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).expect("a result serializes")
                );
            } else {
                print_test(&result);
            }
            Ok(result.status == RunStatus::Passed)
        }
    }
}

/// Reads a tool's output from stdin in the adapter's format, or the one named, and prints what it found.
fn parse_stdin(adapters: &Adapters, args: &Args) -> Result<bool, String> {
    use std::io::Read;
    let name = args.adapter.as_deref().ok_or("parse needs --adapter")?;
    let adapter = adapters
        .get(name)
        .ok_or_else(|| format!("No adapter is named {name}."))?;
    let format = match args.format.as_deref() {
        None | Some("errorformat") => {
            format::Format::Errorformat(adapter.output.errorformat.clone())
        }
        Some("sarif") => format::Format::Sarif,
        Some("junit") => format::Format::Junit,
        Some("tap") => format::Format::Tap,
        Some("raw") => format::Format::Raw,
        Some(other) => return Err(format!("unknown format {other}")),
    };
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    let root = match &args.root {
        Some(root) => root.clone(),
        None => std::env::current_dir()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned(),
    };
    let streams = format::Streams {
        prefixes: adapter
            .output
            .prefixes
            .iter()
            .map(|p| p.regex().clone())
            .collect(),
        ..Default::default()
    };
    let context = format::ParseContext {
        root: &root,
        cwd: &args.cwd,
        source: name,
        streams: &streams,
    };
    let parsed = format::parse(&format, &text, "", None, &context)?;
    let counts = parsed.counts.map(
        |c| serde_json::json!({ "passed": c.passed, "failed": c.failed, "skipped": c.skipped }),
    );
    let answer = serde_json::json!({ "diagnostics": parsed.diagnostics, "output": parsed.output, "counts": counts });
    println!("{answer}");
    Ok(true)
}

fn status(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Passed => "passed",
        RunStatus::Failed => "failed",
        RunStatus::TimedOut => "timed out",
        RunStatus::Skipped => "skipped",
    }
}

fn print_check(result: &CheckResult) {
    for run in &result.checks {
        let exit = run
            .exit_code
            .map(|code| format!(" (exit {code})"))
            .unwrap_or_default();
        println!(
            "{} {}{exit} in {} ms: {}",
            run.id,
            status(run.status),
            run.duration_ms,
            run.command
        );
        for d in &run.diagnostics {
            let severity = match d.severity {
                Severity::Error => "error",
                Severity::Warning => "warning",
                Severity::Information => "info",
                Severity::Hint => "hint",
            };
            let code = d
                .code
                .as_deref()
                .map(|code| format!(" {code}"))
                .unwrap_or_default();
            let at = d.range.start;
            println!(
                "  {}:{}:{} {severity}{code} {}",
                d.path,
                at.line + 1,
                at.character + 1,
                d.message
            );
        }
        if run.status != RunStatus::Passed && run.diagnostics.is_empty() {
            run.output
                .iter()
                .take(40)
                .for_each(|line| println!("  {line}"));
        }
        if run.truncated {
            println!(
                "  [{}'s output was cut, so some diagnostics may be missing.]",
                run.id
            );
        }
    }
}

fn print_test(result: &TestResult) {
    let counts = match (result.passed, result.failed, result.skipped) {
        (Some(p), Some(f), Some(s)) => format!(": {p} passed, {f} failed, {s} skipped"),
        _ => String::new(),
    };
    println!("{}", result.output.trim_end());
    println!(
        "test {} in {} ms{counts}: {}",
        status(result.status),
        result.duration_ms,
        result.command
    );
}
