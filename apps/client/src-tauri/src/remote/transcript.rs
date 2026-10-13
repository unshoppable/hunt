//! Claude Code transcripts on the move: a session's conversation lives in `~/.claude/projects/<slug of its working
//! directory>/<session id>.jsonl` plus a folder of the same name (subagent transcripts, tool results). Its text names
//! the working directory and that project folder, so both are rewritten when the session changes machines.

use std::path::Path;

/// Claude Code's folder name below `~/.claude/projects` for a session working in `cwd`: every character other than
/// an ASCII letter or digit becomes `-`.
pub fn project_slug(cwd: &str) -> String {
    cwd.chars().map(|character| if character.is_ascii_alphanumeric() { character } else { '-' }).collect()
}

/// `text` with every `from` of `replacements` replaced by its `to`, the longest `from` first so that a path is never
/// rewritten through a shorter one it contains.
pub fn rewrite(text: &str, replacements: &[(String, String)]) -> String {
    let mut ordered: Vec<&(String, String)> = replacements.iter().filter(|(from, _)| !from.is_empty()).collect();
    ordered.sort_by_key(|(from, _)| std::cmp::Reverse(from.len()));
    let mut result = text.to_string();
    for (from, to) in ordered {
        result = result.replace(from.as_str(), to);
    }
    result
}

/// Rejects a session id that could leave the project folder as a file name.
pub fn ensure_session_id(acp_session_id: &str) -> Result<(), String> {
    let is_valid = !acp_session_id.is_empty()
        && acp_session_id.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_');
    if !is_valid {
        return Err(format!("failed to move the transcript: {acp_session_id:?} is not a session id"));
    }
    Ok(())
}

/// Copies every file below `from_dir` into `to_dir` (created as needed), rewriting the text of UTF-8 files with
/// `replacements`; other files are copied as they are. Existing files in `to_dir` are overwritten. Symlinks and special
/// files stay behind: the files may come from the VM, and a link there could point anywhere on this machine.
pub fn copy_rewritten(from_dir: &Path, to_dir: &Path, replacements: &[(String, String)]) -> Result<(), String> {
    std::fs::create_dir_all(to_dir).map_err(|error| format!("failed to create {}: {error}", to_dir.display()))?;
    let entries = std::fs::read_dir(from_dir).map_err(|error| format!("failed to read {}: {error}", from_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let source = entry.path();
        let target = to_dir.join(entry.file_name());
        if file_type.is_dir() {
            copy_rewritten(&source, &target, replacements)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let bytes = std::fs::read(&source).map_err(|error| format!("failed to read {}: {error}", source.display()))?;
        let content = match String::from_utf8(bytes) {
            Ok(text) => rewrite(&text, replacements).into_bytes(),
            Err(error) => error.into_bytes(),
        };
        std::fs::write(&target, content).map_err(|error| format!("failed to write {}: {error}", target.display()))?;
    }
    Ok(())
}

/// Copies the transcript of `acp_session_id` (its `.jsonl` and the folder of the same name, when present) from the
/// project folder `from_dir` into `to_dir`, rewriting paths with `replacements`. Returns whether a transcript existed.
pub fn copy_session(from_dir: &Path, to_dir: &Path, acp_session_id: &str, replacements: &[(String, String)]) -> Result<bool, String> {
    ensure_session_id(acp_session_id)?;
    let transcript = from_dir.join(format!("{acp_session_id}.jsonl"));
    if !std::fs::symlink_metadata(&transcript).is_ok_and(|metadata| metadata.is_file()) {
        return Ok(false);
    }
    std::fs::create_dir_all(to_dir).map_err(|error| format!("failed to create {}: {error}", to_dir.display()))?;
    let text = std::fs::read_to_string(&transcript).map_err(|error| format!("failed to read {}: {error}", transcript.display()))?;
    let target = to_dir.join(format!("{acp_session_id}.jsonl"));
    std::fs::write(&target, rewrite(&text, replacements)).map_err(|error| format!("failed to write {}: {error}", target.display()))?;
    let folder = from_dir.join(acp_session_id);
    if std::fs::symlink_metadata(&folder).is_ok_and(|metadata| metadata.is_dir()) {
        copy_rewritten(&folder, &to_dir.join(acp_session_id), replacements)?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_slug_replaces_everything_but_letters_and_digits() {
        assert_eq!(
            project_slug("/Users/jane/Library/Application Support/info.medconomy.harness/worktrees/0123abcd-1111"),
            "-Users-jane-Library-Application-Support-info-medconomy-harness-worktrees-0123abcd-1111"
        );
        assert_eq!(project_slug("/srv/worktrees/a_b"), "-srv-worktrees-a-b");
    }

    #[test]
    fn rewrite_prefers_the_longest_match_and_leaves_lookalikes_alone() {
        let replacements = vec![
            ("/Users/jane/wt".to_string(), "/srv/worktrees/x".to_string()),
            ("/Users/jane/wt/sub".to_string(), "/elsewhere".to_string()),
        ];
        assert_eq!(rewrite("cd /Users/jane/wt/sub && ls /Users/jane/wt/a", &replacements), "cd /elsewhere && ls /srv/worktrees/x/a");
        let back = vec![("/srv/worktrees/x".to_string(), "/Users/jane/wt".to_string())];
        assert_eq!(rewrite("edit .github/workflows/ci.yml in /srv/worktrees/x", &back), "edit .github/workflows/ci.yml in /Users/jane/wt");
    }

    #[test]
    fn copy_session_moves_the_transcript_and_its_folder_with_rewritten_paths() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        std::fs::write(from.path().join("abc.jsonl"), "{\"cwd\":\"/Users/jane/wt\"}\n").unwrap();
        std::fs::create_dir_all(from.path().join("abc/tool-results")).unwrap();
        std::fs::write(from.path().join("abc/tool-results/1.txt"), "see /Users/jane/wt/README.md").unwrap();
        std::fs::write(from.path().join("abc/tool-results/2.bin"), [0xff, 0xfe, 0x00]).unwrap();
        std::fs::write(from.path().join("other.jsonl"), "untouched").unwrap();
        let replacements = vec![("/Users/jane/wt".to_string(), "/srv/worktrees/x".to_string())];

        assert!(copy_session(from.path(), to.path(), "abc", &replacements).unwrap());
        assert_eq!(std::fs::read_to_string(to.path().join("abc.jsonl")).unwrap(), "{\"cwd\":\"/srv/worktrees/x\"}\n");
        assert_eq!(std::fs::read_to_string(to.path().join("abc/tool-results/1.txt")).unwrap(), "see /srv/worktrees/x/README.md");
        assert_eq!(std::fs::read(to.path().join("abc/tool-results/2.bin")).unwrap(), vec![0xff, 0xfe, 0x00]);
        assert!(!to.path().join("other.jsonl").exists());
        assert!(!copy_session(from.path(), to.path(), "missing", &replacements).unwrap());
        assert!(copy_session(from.path(), to.path(), "../abc", &replacements).is_err());
    }

    #[test]
    fn copy_rewritten_leaves_symlinks_behind() {
        let from = tempfile::tempdir().unwrap();
        let to = tempfile::tempdir().unwrap();
        let secrets = tempfile::tempdir().unwrap();
        std::fs::write(secrets.path().join("id_ed25519"), "secret").unwrap();
        std::fs::write(from.path().join("note.txt"), "kept").unwrap();
        std::os::unix::fs::symlink(secrets.path(), from.path().join("keys")).unwrap();
        std::os::unix::fs::symlink(secrets.path().join("id_ed25519"), from.path().join("key.txt")).unwrap();

        copy_rewritten(from.path(), to.path(), &[]).unwrap();

        assert_eq!(std::fs::read_to_string(to.path().join("note.txt")).unwrap(), "kept");
        assert!(!to.path().join("keys").exists());
        assert!(!to.path().join("key.txt").exists());
    }
}
