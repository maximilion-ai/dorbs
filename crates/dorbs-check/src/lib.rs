pub mod adapter;
pub mod config;
pub mod docker;
pub mod egress;
pub mod env;
pub mod environments;
pub mod format;
pub mod git;
pub mod github;
pub mod http;
pub mod local;
pub mod process;
pub mod protocol;
pub mod recipe;
pub mod repo_commands;
pub mod run;
pub mod service;
pub mod view;

/// Prints a line to the service's log, after the time.
pub fn log(line: &str) {
    let millis = environments::now();
    let (secs, ms) = (millis / 1000, millis % 1000);
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    eprintln!("{h:02}:{m:02}:{s:02}.{ms:03} {line}");
}

/// 16 random hex characters, for names nothing else picks.
pub fn random_id() -> String {
    use rand_core::RngCore;
    let mut bytes = [0u8; 8];
    rand_core::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
