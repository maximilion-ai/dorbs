//! An environment's tree: a change laid over it in place and taken off again with git.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use dorbs_check::git::{Overlaid, Tree};
use dorbs_check::protocol::{Change, CommitSha, File, RelativePath};

struct Fixture {
    root: PathBuf,
    tree: Tree,
    first: CommitSha,
    second: CommitSha,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn git(args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

/// A bare repo with a first commit, and a second that changes src/a.ts and drops src/old.ts.
fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("dorbs-check-tree-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let (git_dir, work) = (root.join("repo.git"), root.join("work"));
    std::fs::create_dir_all(work.join("src")).unwrap();
    std::fs::write(work.join("package.json"), "{}\n").unwrap();
    std::fs::write(work.join("src/a.ts"), "export const a = 1;\n").unwrap();
    std::fs::write(work.join("src/old.ts"), "export const old = 1;\n").unwrap();
    std::os::unix::fs::symlink("/etc", work.join("link")).unwrap();
    std::os::unix::fs::symlink("a.ts", work.join("src/self")).unwrap();
    let (g, w) = (
        git_dir.to_string_lossy().into_owned(),
        work.to_string_lossy().into_owned(),
    );
    git(&["init", "--quiet", "--bare", &g]);
    let commit = |message: &str| {
        git(&["--git-dir", &g, "--work-tree", &w, "add", "--all"]);
        git(&[
            "--git-dir",
            &g,
            "--work-tree",
            &w,
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            message,
        ]);
        CommitSha::try_from(git(&["--git-dir", &g, "rev-parse", "HEAD"])).unwrap()
    };
    let first = commit("first");
    std::fs::write(work.join("src/a.ts"), "export const a = 2;\n").unwrap();
    std::fs::remove_file(work.join("src/old.ts")).unwrap();
    let second = commit("second");
    let tree = Tree {
        git_dir,
        work_tree: root.join("env/repo"),
        index_file: root.join("env.index"),
    };
    Fixture {
        root,
        tree,
        first,
        second,
    }
}

/// Every file under the tree: its content, or where it links.
fn snapshot(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, files: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let kind = entry.file_type().unwrap();
            if kind.is_symlink() {
                files.insert(
                    name,
                    format!("-> {}", std::fs::read_link(&path).unwrap().display()),
                );
            } else if kind.is_dir() {
                walk(root, &path, files);
            } else {
                files.insert(name, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let mut files = BTreeMap::new();
    walk(dir, dir, &mut files);
    files
}

fn path(value: &str) -> RelativePath {
    RelativePath::try_from(value).unwrap()
}

fn file(at: &str, content: &str) -> File {
    File {
        path: path(at),
        content: content.to_owned(),
    }
}

#[tokio::test]
async fn lays_a_change_over_the_tree_in_place_and_takes_it_off_again() {
    let f = fixture("overlay");
    f.tree.materialize(&f.first, None).await.unwrap();
    let clean = snapshot(&f.tree.work_tree);
    // Install output the tree does not track stays where it is.
    std::fs::create_dir_all(f.tree.work_tree.join("node_modules/x")).unwrap();
    std::fs::write(f.tree.work_tree.join("node_modules/x/index.js"), "1").unwrap();
    let change = Change {
        files: vec![
            file("src/a.ts", "export const a = 'x';\n"),
            file("src/new/deep/b.ts", "export const b = 1;\n"),
            file("src/self", "no longer a link\n"),
        ],
        deleted: vec![path("src/old.ts")],
    };
    let overlay = f.tree.overlay(&change).unwrap();
    let laid = snapshot(&f.tree.work_tree);
    assert_eq!(laid["src/a.ts"], "export const a = 'x';\n");
    assert_eq!(laid["src/new/deep/b.ts"], "export const b = 1;\n");
    assert_eq!(laid["src/self"], "no longer a link\n");
    assert!(!laid.contains_key("src/old.ts"));
    f.tree.restore(&overlay).await.unwrap();
    let mut expected = clean;
    expected.insert("node_modules/x/index.js".into(), "1".into());
    assert_eq!(snapshot(&f.tree.work_tree), expected);
}

#[tokio::test]
async fn refuses_a_write_through_a_symbolic_link_of_the_tree_and_writes_nothing() {
    let f = fixture("refuse");
    f.tree.materialize(&f.first, None).await.unwrap();
    let clean = snapshot(&f.tree.work_tree);
    let change = Change {
        files: vec![
            file("link/passwd.ts", "x"),
            file("src/a.ts", "y"),
            file("src", "a file over a directory"),
        ],
        deleted: vec![path("link/hosts")],
    };
    assert_eq!(
        f.tree.overlay(&change).unwrap_err(),
        Overlaid::Unsafe(vec![
            path("link/hosts"),
            path("link/passwd.ts"),
            path("src")
        ])
    );
    assert_eq!(snapshot(&f.tree.work_tree), clean);
}

#[tokio::test]
async fn moves_the_tree_to_another_commit_deleting_what_it_dropped() {
    let f = fixture("move");
    f.tree.materialize(&f.first, None).await.unwrap();
    f.tree.move_to(&f.first, &f.second).await.unwrap();
    let moved = snapshot(&f.tree.work_tree);
    assert_eq!(moved["src/a.ts"], "export const a = 2;\n");
    assert!(!moved.contains_key("src/old.ts"));
    f.tree.move_to(&f.second, &f.first).await.unwrap();
    assert_eq!(
        snapshot(&f.tree.work_tree)["src/old.ts"],
        "export const old = 1;\n"
    );
}

#[tokio::test]
async fn takes_off_an_overlay_a_crash_left_behind() {
    let f = fixture("crash");
    f.tree.materialize(&f.first, None).await.unwrap();
    let clean = snapshot(&f.tree.work_tree);
    f.tree
        .overlay(&Change {
            files: vec![file("src/z/c.ts", "1")],
            deleted: vec![path("src/a.ts")],
        })
        .unwrap();
    f.tree.recover().await.unwrap();
    assert_eq!(snapshot(&f.tree.work_tree), clean);
    f.tree.recover().await.unwrap();
}

#[tokio::test]
async fn takes_an_overlay_off_without_following_a_link_a_run_put_in_its_way() {
    let f = fixture("links");
    f.tree.materialize(&f.first, None).await.unwrap();
    let outside = f.root.join("outside");
    std::fs::create_dir_all(outside.join("deep")).unwrap();
    std::fs::write(outside.join("deep/b.ts"), "keep me").unwrap();
    std::fs::write(outside.join("a.ts"), "keep me too").unwrap();
    let overlay = f
        .tree
        .overlay(&Change {
            files: vec![file("src/new/deep/b.ts", "1"), file("lib/a.ts", "2")],
            deleted: vec![],
        })
        .unwrap();
    // A check swaps the directories the overlay wrote into for links out of the tree.
    for dir in ["src/new", "lib"] {
        std::fs::remove_dir_all(f.tree.work_tree.join(dir)).unwrap();
        std::os::unix::fs::symlink(&outside, f.tree.work_tree.join(dir)).unwrap();
    }
    f.tree.restore(&overlay).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(outside.join("deep/b.ts")).unwrap(),
        "keep me"
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("a.ts")).unwrap(),
        "keep me too"
    );
    assert!(!f.tree.work_tree.join("src/new").exists());
    assert!(!f.tree.work_tree.join("lib").exists());
}

#[tokio::test]
async fn puts_back_a_tracked_file_a_run_changed_or_deleted_outside_the_overlay() {
    let f = fixture("drift");
    f.tree.materialize(&f.first, None).await.unwrap();
    let clean = snapshot(&f.tree.work_tree);
    let overlay = f
        .tree
        .overlay(&Change {
            files: vec![file("src/a.ts", "x")],
            deleted: vec![],
        })
        .unwrap();
    std::fs::write(f.tree.work_tree.join("package.json"), "poisoned").unwrap();
    std::fs::remove_file(f.tree.work_tree.join("src/old.ts")).unwrap();
    f.tree.restore(&overlay).await.unwrap();
    assert_eq!(snapshot(&f.tree.work_tree), clean);
}

#[tokio::test]
async fn checks_out_only_the_paths_an_online_step_sees() {
    let f = fixture("online");
    f.tree
        .materialize(&f.first, Some(&[path("package.json")]))
        .await
        .unwrap();
    assert_eq!(
        snapshot(&f.tree.work_tree),
        BTreeMap::from([("package.json".to_owned(), "{}\n".to_owned())])
    );
}

#[tokio::test]
async fn touches_nothing_through_a_tree_whose_root_a_run_swapped_for_a_link() {
    let f = fixture("root");
    f.tree.materialize(&f.first, None).await.unwrap();
    let overlay = f
        .tree
        .overlay(&Change {
            files: vec![file("src/a.ts", "x")],
            deleted: vec![],
        })
        .unwrap();
    let outside = f.root.join("outside");
    std::fs::create_dir_all(outside.join("src")).unwrap();
    std::fs::write(outside.join("src/a.ts"), "keep me").unwrap();
    std::fs::rename(&f.tree.work_tree, f.root.join("moved")).unwrap();
    std::os::unix::fs::symlink(&outside, &f.tree.work_tree).unwrap();
    assert!(f.tree.restore(&overlay).await.is_err());
    assert!(f.tree.recover().await.is_err());
    assert!(f.tree.move_to(&f.first, &f.second).await.is_err());
    assert!(matches!(
        f.tree.overlay(&Change {
            files: vec![file("x.ts", "x")],
            deleted: vec![]
        }),
        Err(Overlaid::Broken(_))
    ));
    assert_eq!(
        snapshot(&outside),
        BTreeMap::from([("src/a.ts".to_owned(), "keep me".to_owned())])
    );
}
