//! The software Hunt runs on the session VMs and the gateway, shipped with the app as the `remote/` folder of this
//! repository: the relay, the session configuration and `hunt-ctl`. Hunt installs it whenever a VM runs a different
//! version, so the VMs never need access to GitHub and always match the app that talks to them.

use std::path::Path;

use sha2::{Digest, Sha256};

use super::ssh::Ssh;
use super::{shell_command, tar_create, Progress, RemoteStep};

/// Names left out of the bundle and its hash.
const SKIPPED: [&str; 2] = ["node_modules", ".DS_Store"];

/// The bundle's version: the first 16 hex digits of a SHA-256 over every file below `dir`, relative path and content,
/// in path order.
pub fn hash(dir: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect_files(dir, "", &mut files)?;
    files.sort();
    let mut hasher = Sha256::new();
    for relative in &files {
        let content = std::fs::read(dir.join(relative)).map_err(|error| format!("failed to read {relative} of the remote bundle: {error}"))?;
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(&content);
        hasher.update([0]);
    }
    Ok(hasher.finalize().iter().take(8).map(|byte| format!("{byte:02x}")).collect())
}

/// Adds the paths of every file below `dir` (relative, `/`-separated, prefixed with `prefix`) to `files`.
fn collect_files(dir: &Path, prefix: &str, files: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIPPED.contains(&name.as_str()) {
            continue;
        }
        let relative = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, &relative, files)?;
        } else {
            files.push(relative);
        }
    }
    Ok(())
}

/// Prints the hash of the VM's last complete install, which `hunt-ctl install` writes as its last step, and the
/// gateway's preview domain, one line each; a missing file gives an empty line.
const INSTALL_STATE_COMMAND: &str =
    r#"printf '%s\n' "$(cat /var/lib/hunt/installed-hash 2>/dev/null)" "$(cat /etc/hunt/preview-domain 2>/dev/null)""#;

/// Installs the bundle in `dir` on the VM unless the VM completed an install of that version; returns its hash. The
/// gateway passes its preview `domain`, which `hunt-ctl install` writes into its edge proxy, and installs again when
/// the domain changed.
pub async fn ensure_installed(ssh: &Ssh, dir: &Path, domain: Option<&str>, progress: Progress<'_>) -> Result<String, String> {
    let hash = hash(dir)?;
    let state = ssh.run(INSTALL_STATE_COMMAND).await?;
    if is_installed(&state, &hash, domain) {
        return Ok(hash);
    }

    progress(RemoteStep::InstallingRuntime);
    let archive = tar_create(dir, &[".".to_string()]).await?;
    // Unpacked into a folder of its own, so two installs at once cannot mix their files, and installed from there by
    // `hunt-ctl` of this very bundle, which copies it into the releases.
    let incoming = format!("/srv/hunt/incoming/{}", uuid::Uuid::new_v4());
    let mut install_args = vec!["install", incoming.as_str()];
    install_args.extend(domain.map(|domain| ["--domain", domain]).into_iter().flatten());
    let install = shell_command(&format!("{incoming}/vm/hunt-ctl"), &install_args);
    let script = format!(
        "set -e; mkdir -p {incoming}; trap 'rm -rf {incoming}' EXIT; tar -xzf - -C {incoming}; printf %s {hash} > {incoming}/.hash; \
         find {incoming}/vm -maxdepth 1 -type f -name 'hunt-*' -exec chmod +x {{}} +; {install}"
    );
    ssh.run_with_input(&shell_command("sudo", &["-n", "sh", "-c", &script]), &archive)
        .await
        .map_err(|error| format!("failed to install the remote runtime: {error}"))?;
    Ok(hash)
}

/// Whether `state`, the installed hash and the preview domain the VM reports on one line each, shows a complete install
/// of `hash` and, when given, `domain`.
fn is_installed(state: &str, hash: &str, domain: Option<&str>) -> bool {
    let mut lines = state.lines().map(str::trim);
    let (installed_hash, installed_domain) = (lines.next().unwrap_or_default(), lines.next().unwrap_or_default());
    installed_hash == hash && domain.is_none_or(|domain| installed_domain == domain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_covers_paths_and_contents_but_skips_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("relay")).unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/x")).unwrap();
        std::fs::write(dir.path().join("relay/main.ts"), "a").unwrap();
        std::fs::write(dir.path().join("node_modules/x/index.js"), "ignored").unwrap();

        let first = hash(dir.path()).unwrap();
        assert_eq!(first.len(), 16);
        std::fs::write(dir.path().join("node_modules/x/index.js"), "changed").unwrap();
        assert_eq!(hash(dir.path()).unwrap(), first);

        std::fs::write(dir.path().join("relay/main.ts"), "b").unwrap();
        let second = hash(dir.path()).unwrap();
        assert_ne!(second, first);

        std::fs::rename(dir.path().join("relay/main.ts"), dir.path().join("relay/other.ts")).unwrap();
        assert_ne!(hash(dir.path()).unwrap(), second);
    }

    #[test]
    fn is_installed_needs_the_complete_install_of_the_hash_and_the_gateways_domain() {
        assert!(is_installed("0123456789abcdef\n\n", "0123456789abcdef", None));
        assert!(is_installed("0123456789abcdef\nhunt.example.com\n", "0123456789abcdef", Some("hunt.example.com")));
        assert!(!is_installed("0123456789abcdef\nold.example.com\n", "0123456789abcdef", Some("hunt.example.com")));
        assert!(!is_installed("0123456789abcdef\n\n", "0123456789abcdef", Some("hunt.example.com")));
        assert!(!is_installed("fedcba9876543210\nhunt.example.com\n", "0123456789abcdef", Some("hunt.example.com")));
        assert!(!is_installed("\n\n", "0123456789abcdef", None));
        assert!(!is_installed("", "0123456789abcdef", None));
    }
}
