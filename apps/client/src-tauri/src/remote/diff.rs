//! The changes of a remote session on its VM, read-only and in the shapes of the local changelist (`git.rs`): every
//! command runs git in the session's worktree as the agent's user in one SSH round trip. The base is the merge base of
//! the VM's `HEAD` with the commit the session was handed off at, or else with the origin's default branch, so the
//! changes include the agent's commits.

use serde::Serialize;
use uuid::Uuid;

use super::shell_command;
use super::ssh::Ssh;
use crate::git::{ChangedFile, FileDiff};

/// The changes of a remote session: the commit they are compared against and the changed files, sorted by path.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteChanges {
    /// Whether the session's VM runs; a VM that is off has no changes to show and `base` is `None`.
    pub vm_running: bool,
    pub base: Option<String>,
    pub files: Vec<ChangedFile>,
}

impl RemoteChanges {
    /// The changes of a session whose VM is off.
    pub fn vm_off() -> Self {
        RemoteChanges { vm_running: false, base: None, files: Vec::new() }
    }
}

/// Prints the base commit, then `<status>\0<path>\0` for every tracked change against it and `?\0<path>\0` for every
/// untracked file. Arguments: the worktree, the handoff head (may be empty) and the Hunt session id.
const CHANGES_SCRIPT: &str = r#"
cd -- "$1" || exit 1
handoff_head=$2
handoff_ref=refs/hunt/$3/handoff
base=
if [ -n "$handoff_head" ]; then
  base=$(git merge-base HEAD "$handoff_head" 2>/dev/null) || base=
fi
if [ -z "$base" ] && git rev-parse -q --verify "$handoff_ref^{commit}" >/dev/null 2>&1; then
  base=$(git merge-base HEAD "$handoff_ref^" 2>/dev/null) || base=
fi
if [ -z "$base" ]; then
  default=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null) || default=
  for candidate in $default refs/remotes/origin/main refs/remotes/origin/master; do
    base=$(git merge-base HEAD "$candidate" 2>/dev/null) && break
    base=
  done
fi
if [ -z "$base" ]; then
  base=$(git rev-parse -q --verify HEAD) || base=$(git hash-object -t tree /dev/null) || exit 1
fi
printf '%s\0' "$base"
git diff --name-status -z --no-renames "$base" -- || exit 1
git ls-files -z --others --exclude-standard | while IFS= read -r -d '' path; do
  printf '?\0%s\0' "$path"
done
"#;

/// Prints three sections, each as its length in bytes on a line followed by the bytes, or `-` on a line when it does
/// not exist: the file at the base commit, the file in the worktree and the unified diff between them. Arguments: the
/// worktree, the base commit and the worktree-relative path.
const FILE_DIFF_SCRIPT: &str = r#"
cd -- "$1" || exit 1
base=$2
path=$3
section() {
  out=$(mktemp) || exit 1
  if "$@" >"$out" 2>/dev/null; then
    printf '%s\n' "$(wc -c <"$out" | tr -d ' ')"
    cat -- "$out"
  else
    printf -- '-\n'
  fi
  rm -f -- "$out"
}
differs() {
  "$@"
  [ $? -le 1 ]
}
section git show "$base:$path"
if [ -f "$path" ]; then section cat -- "$path"; else printf -- '-\n'; fi
if git cat-file -e "$base:$path" 2>/dev/null; then
  section differs git diff "$base" -- "$path"
else
  section differs git diff --no-index -- /dev/null "$path"
fi
"#;

/// The changes in the session's `worktree` on the VM behind `ssh`, against the merge base with `handoff_head` (empty
/// when unknown), the handoff snapshot of session `id`, or the origin's default branch.
pub async fn changed_files(ssh: &Ssh, worktree: &str, id: Uuid, handoff_head: &str) -> Result<RemoteChanges, String> {
    if !handoff_head.is_empty() && !is_commit_id(handoff_head) {
        return Err(format!("failed to list the changes on the VM: {handoff_head:?} is no commit"));
    }
    let output = ssh
        .run_with_input(&as_agent(CHANGES_SCRIPT, &[worktree, handoff_head, &id.to_string()]), &[])
        .await
        .map_err(|error| format!("failed to list the changes on the VM: {error}"))?;
    parse_changes(&output)
}

/// The diff of the worktree-relative `path` in the session's `worktree` on the VM behind `ssh` against `base`, a
/// commit `changed_files` returned.
pub async fn file_diff(ssh: &Ssh, worktree: &str, base: &str, path: &str) -> Result<FileDiff, String> {
    if !is_commit_id(base) {
        return Err(format!("failed to read the diff on the VM: {base:?} is no commit"));
    }
    let output = ssh
        .run_with_input(&as_agent(FILE_DIFF_SCRIPT, &[worktree, base, path]), &[])
        .await
        .map_err(|error| format!("failed to read the diff of {path} on the VM: {error}"))?;
    parse_file_diff(path, &output)
}

/// The remote command that runs the bash `script` with `args` as the agent's user.
fn as_agent(script: &str, args: &[&str]) -> String {
    let mut command_args = vec!["-n", "-u", "agent", "bash", "-c", script, "bash"];
    command_args.extend_from_slice(args);
    shell_command("sudo", &command_args)
}

/// Whether `value` is a full SHA-1 or SHA-256 object id.
fn is_commit_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.chars().all(|character| character.is_ascii_hexdigit())
}

/// Reads the output of `CHANGES_SCRIPT`.
fn parse_changes(output: &[u8]) -> Result<RemoteChanges, String> {
    let text = String::from_utf8_lossy(output);
    let mut fields = text.split('\0');
    let base = fields.next().unwrap_or_default().trim().to_string();
    if !is_commit_id(&base) {
        return Err(format!("failed to list the changes on the VM: the base {base:?} is no commit"));
    }
    let mut files = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let Some(path) = fields.next().filter(|path| !path.is_empty()) else {
            return Err(format!("failed to list the changes on the VM: the status {status:?} names no file"));
        };
        let status = status.chars().next().map(String::from).unwrap_or_default();
        files.push(ChangedFile { path: path.to_string(), status });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(RemoteChanges { vm_running: true, base: Some(base), files })
}

/// Reads the output of `FILE_DIFF_SCRIPT` for `path`. Like the local `git::file_diff`, a base version that is no UTF-8
/// comes lossily and a worktree version that is no UTF-8 not at all.
fn parse_file_diff(path: &str, output: &[u8]) -> Result<FileDiff, String> {
    let mut sections = parse_sections(output, 3)?.into_iter();
    let mut next = || sections.next().flatten();
    let old_content = next().map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
    let new_content = next().and_then(|bytes| String::from_utf8(bytes).ok());
    let unified = next().map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).unwrap_or_default();
    Ok(FileDiff { path: path.to_string(), old_content, new_content, unified })
}

/// Splits `output` into `count` sections, each a line with its length in bytes (or `-` for a missing one) followed by
/// that many bytes.
fn parse_sections(output: &[u8], count: usize) -> Result<Vec<Option<Vec<u8>>>, String> {
    let mut sections = Vec::with_capacity(count);
    let mut rest = output;
    for _ in 0..count {
        let line_end = rest.iter().position(|byte| *byte == b'\n').ok_or("failed to read the diff from the VM: its output ends early")?;
        let header = String::from_utf8_lossy(&rest[..line_end]).trim().to_string();
        rest = &rest[line_end + 1..];
        if header == "-" {
            sections.push(None);
            continue;
        }
        let length: usize = header.parse().map_err(|_| format!("failed to read the diff from the VM: {header:?} is no length"))?;
        if rest.len() < length {
            return Err("failed to read the diff from the VM: its output ends early".into());
        }
        sections.push(Some(rest[..length].to_vec()));
        rest = &rest[length..];
    }
    Ok(sections)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::git;

    #[test]
    fn as_agent_runs_the_script_with_quoted_arguments_as_the_agent() {
        let command = as_agent("echo \"$1\" 'x'", &["/home/agent/my app", ""]);
        assert_eq!(command, r#"sudo -n -u agent bash -c 'echo "$1" '\''x'\''' bash '/home/agent/my app' ''"#);
    }

    #[test]
    fn parse_changes_reads_the_base_and_every_status_and_path() {
        let base = "a".repeat(40);
        let output = format!("{base}\0M\0src/app.ts\0D\0old name.txt\0A\0new.ts\0?\0notes/todo.md\0?\0src/app.ts\0");
        let changes = parse_changes(output.as_bytes()).unwrap();
        assert!(changes.vm_running);
        assert_eq!(changes.base.as_deref(), Some(base.as_str()));
        let files: Vec<(&str, &str)> = changes.files.iter().map(|file| (file.status.as_str(), file.path.as_str())).collect();
        assert_eq!(files, vec![("A", "new.ts"), ("?", "notes/todo.md"), ("D", "old name.txt"), ("M", "src/app.ts")]);

        assert!(parse_changes(format!("{base}\0").as_bytes()).unwrap().files.is_empty());
        assert!(parse_changes(b"not a commit\0M\0a\0").is_err());
        assert!(parse_changes(format!("{base}\0M\0").as_bytes()).is_err());
    }

    #[test]
    fn parse_sections_reads_lengths_and_missing_sections() {
        let output = b"5\nab\ncd-\n0\n";
        assert_eq!(parse_sections(output, 3).unwrap(), vec![Some(b"ab\ncd".to_vec()), None, Some(Vec::new())]);
        assert!(parse_sections(b"9\nshort", 1).is_err());
        assert!(parse_sections(b"x\n", 1).is_err());
        assert!(parse_sections(b"-\n", 2).is_err());
    }

    #[test]
    fn parse_file_diff_keeps_a_worktree_version_only_when_it_is_text() {
        let diff = parse_file_diff("a.txt", b"4\nold\n-\n0\n").unwrap();
        assert_eq!((diff.old_content.as_deref(), diff.new_content.as_deref(), diff.unified.as_str()), (Some("old\n"), None, ""));
        let binary = parse_file_diff("b.bin", b"-\n2\n\xff\xfe-\n").unwrap();
        assert_eq!((binary.old_content, binary.new_content, binary.unified.as_str()), (None, None, ""));
    }

    #[test]
    fn is_commit_id_accepts_full_hex_ids_only() {
        assert!(is_commit_id(&"0123456789abcdef".repeat(4)[..40]));
        assert!(is_commit_id(&"f".repeat(64)));
        assert!(!is_commit_id("HEAD"));
        assert!(!is_commit_id(&"g".repeat(40)));
        assert!(!is_commit_id(&"a".repeat(39)));
    }

    /// Runs `script` with `args` the way the VM does, minus `sudo`.
    async fn run_script(script: &str, args: &[&str]) -> Vec<u8> {
        let output = tokio::process::Command::new("bash").arg("-c").arg(script).arg("bash").args(args).output().await.unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        output.stdout
    }

    async fn git(dir: &Path, args: &[&str]) -> String {
        git::run_git(dir, args).await.unwrap().trim().to_string()
    }

    /// A repository like a session's worktree on the VM: `origin/main`, the handoff head on top of it, then the agent's
    /// commit and uncommitted work.
    async fn session_worktree(dir: &Path) -> (String, String) {
        git(dir, &["init", "-q", "-b", "main"]).await;
        git(dir, &["config", "user.email", "agent@example.com"]).await;
        git(dir, &["config", "user.name", "Agent"]).await;
        std::fs::write(dir.join("kept.txt"), "kept\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "gone\n").unwrap();
        git(dir, &["add", "."]).await;
        git(dir, &["commit", "-q", "-m", "main"]).await;
        let main = git(dir, &["rev-parse", "HEAD"]).await;
        git(dir, &["update-ref", "refs/remotes/origin/main", &main]).await;
        git(dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]).await;
        std::fs::write(dir.join("kept.txt"), "kept\nhanded off\n").unwrap();
        git(dir, &["commit", "-q", "-am", "local work"]).await;
        let handoff_head = git(dir, &["rev-parse", "HEAD"]).await;
        std::fs::write(dir.join("committed.txt"), "by the agent\n").unwrap();
        git(dir, &["add", "committed.txt"]).await;
        git(dir, &["commit", "-q", "-m", "agent work"]).await;
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        std::fs::write(dir.join("kept.txt"), "kept\nhanded off\nedited on the vm\n").unwrap();
        std::fs::write(dir.join("new file.txt"), "untracked\n").unwrap();
        (main, handoff_head)
    }

    #[tokio::test]
    async fn the_changes_script_compares_against_the_handoff_head_or_the_default_branch() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();
        let (main, handoff_head) = session_worktree(dir.path()).await;
        let id = "ab12cd34-0000-4000-8000-000000000001";
        let listed = |changes: &RemoteChanges| {
            changes.files.iter().map(|file| format!("{} {}", file.status, file.path)).collect::<Vec<_>>()
        };

        let since_handoff = parse_changes(&run_script(CHANGES_SCRIPT, &[worktree, &handoff_head, id]).await).unwrap();
        assert_eq!(since_handoff.base.as_deref(), Some(handoff_head.as_str()));
        assert_eq!(listed(&since_handoff), ["A committed.txt", "D gone.txt", "M kept.txt", "? new file.txt"]);

        // Without a handoff head the handoff snapshot names it.
        let snapshot = git(dir.path(), &["commit-tree", &format!("{handoff_head}^{{tree}}"), "-p", &handoff_head, "-m", "snapshot"]).await;
        git(dir.path(), &["update-ref", &format!("refs/hunt/{id}/handoff"), &snapshot]).await;
        let from_snapshot = parse_changes(&run_script(CHANGES_SCRIPT, &[worktree, "", id]).await).unwrap();
        assert_eq!(from_snapshot.base.as_deref(), Some(handoff_head.as_str()));

        // A session the poller started has neither, so the default branch is the base.
        let other_id = "00000000-1111-4000-8000-000000000002";
        let from_default = parse_changes(&run_script(CHANGES_SCRIPT, &[worktree, "", other_id]).await).unwrap();
        assert_eq!(from_default.base.as_deref(), Some(main.as_str()));
        assert_eq!(listed(&from_default), ["A committed.txt", "D gone.txt", "M kept.txt", "? new file.txt"]);
    }

    #[tokio::test]
    async fn the_file_diff_script_returns_both_versions_and_the_unified_diff() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().to_str().unwrap();
        let (main, _) = session_worktree(dir.path()).await;

        let edited = parse_file_diff("kept.txt", &run_script(FILE_DIFF_SCRIPT, &[worktree, &main, "kept.txt"]).await).unwrap();
        assert_eq!(edited.old_content.as_deref(), Some("kept\n"));
        assert_eq!(edited.new_content.as_deref(), Some("kept\nhanded off\nedited on the vm\n"));
        assert!(edited.unified.contains("+edited on the vm"), "{}", edited.unified);

        let deleted = parse_file_diff("gone.txt", &run_script(FILE_DIFF_SCRIPT, &[worktree, &main, "gone.txt"]).await).unwrap();
        assert_eq!((deleted.old_content.as_deref(), deleted.new_content.as_deref()), (Some("gone\n"), None));

        let untracked = parse_file_diff("new file.txt", &run_script(FILE_DIFF_SCRIPT, &[worktree, &main, "new file.txt"]).await).unwrap();
        assert_eq!((untracked.old_content.as_deref(), untracked.new_content.as_deref()), (None, Some("untracked\n")));
        assert!(untracked.unified.contains("+untracked"), "{}", untracked.unified);
    }
}
