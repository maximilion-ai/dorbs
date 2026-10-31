// Embeds every adapters/*.toml, so a new ecosystem is one file and no code.
use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("adapters");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .expect("an adapters directory")
        .map(|entry| entry.expect("a readable entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "toml"))
        .collect();
    files.sort();
    let entries: String = files
        .iter()
        .map(|path| {
            let name = path.file_stem().expect("a file name").to_string_lossy();
            format!(
                "    ({name:?}, include_str!({:?})),\n",
                path.display().to_string()
            )
        })
        .collect();
    let out = Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR")).join("adapters.rs");
    std::fs::write(out, format!("/// The adapters the binary carries, by name.\npub const EMBEDDED: &[(&str, &str)] = &[\n{entries}];\n"))
        .expect("a writable OUT_DIR");
}
