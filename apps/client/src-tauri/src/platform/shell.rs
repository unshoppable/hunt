//! The POSIX shell: quoting for the commands Hunt runs on a VM over SSH, through `GIT_SSH_COMMAND` and through a
//! worktree's tmux on this Mac, finding a program on the PATH and writing the scripts Hunt puts into a worktree's
//! `.hunt` (`.hunt/tmux`, `.hunt/hunt-client`).

use std::path::{Path, PathBuf};

/// `value` quoted for a POSIX shell, so it reaches the remote command (or `GIT_SSH_COMMAND`) as one word.
pub fn shell_quote(value: &str) -> String {
    if !value.is_empty() && value.chars().all(|character| character.is_ascii_alphanumeric() || "-_./=:@%+,".contains(character)) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// The remote command `program` with `args`, each quoted for the remote shell.
pub fn shell_command(program: &str, args: &[&str]) -> String {
    let mut command = shell_quote(program);
    for arg in args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    command
}

/// The file `program` in the first folder of the PATH that has one.
pub fn find_on_path(program: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(program)).find(|path| path.is_file())
}

/// Replaces `path` with `text` unless it holds it already; through a temporary file, so that a running `sh` never
/// reads half a script.
pub fn write_if_changed(path: &Path, text: &str, mode: u32) -> Result<(), String> {
    if std::fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    let temporary = path.with_extension("hunt-tmp");
    std::fs::write(&temporary, text).map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    std::fs::set_permissions(&temporary, std::os::unix::fs::PermissionsExt::from_mode(mode))
        .map_err(|error| format!("failed to set the mode of {}: {error}", temporary.display()))?;
    std::fs::rename(&temporary, path).map_err(|error| format!("failed to write {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_leaves_plain_words_and_quotes_the_rest() {
        assert_eq!(shell_quote("refs/hunt/abc"), "refs/hunt/abc");
        assert_eq!(shell_quote("two words"), "'two words'");
        assert_eq!(shell_quote("it's"), r"'it'\''s'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_command("sudo", &["-n", "hunt-ctl", "prepare", "a b"]), "sudo -n hunt-ctl prepare 'a b'");
    }
}
