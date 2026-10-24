//! Reads the ESLint rules a worktree's flat configs set, through `apps/client/scripts/eslintRules.mjs` on the `node` of
//! PATH, so the ESLint and plugins the project installs describe them; see the script for what a config lists.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const SCRIPT: &str = "apps/client/scripts/eslintRules.mjs";
const TIMEOUT: Duration = Duration::from_secs(60);
/// File names ESLint reads a flat config from.
const CONFIG_NAMES: [&str; 6] = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", "eslint.config.mts", "eslint.config.cts"];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintRules {
    #[serde(default)]
    pub configs: Vec<LintConfig>,
    #[serde(default, skip_serializing)]
    error: Option<String>,
}

/// One `eslint.config.*` file: `installed` is false when no ESLint resolves from it, `error` is set when importing it failed.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintConfig {
    pub path: String,
    pub installed: bool,
    pub error: Option<String>,
    pub blocks: Vec<LintBlock>,
}

/// A config object of the flat config array: the globs it applies to and the rules it sets.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintBlock {
    pub files: Vec<String>,
    pub ignores: Vec<String>,
    pub rules: Vec<LintRule>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LintRule {
    pub id: String,
    /// `"error"`, `"warn"` or `"off"`.
    pub severity: String,
    /// The rule's options, the entries after the severity.
    pub options: serde_json::Value,
    pub description: Option<String>,
    pub url: Option<String>,
    /// `"core"`, `"package"` or `"repository"`.
    pub origin: String,
}

/// Whether the worktree-relative `path` is a file ESLint reads a flat config from.
pub fn is_config(path: &str) -> bool {
    Path::new(path).file_name().and_then(|name| name.to_str()).is_some_and(|name| CONFIG_NAMES.contains(&name))
}

/// The rules the configs `configs` (worktree-relative) of `worktree` set, read with the script at `script`.
pub async fn read_lint_rules(script: &Path, worktree: &Path, configs: &[String]) -> Result<LintRules, String> {
    if configs.is_empty() {
        return Ok(LintRules { configs: Vec::new(), error: None });
    }
    let input = json!({ "worktree": worktree, "configs": configs }).to_string();
    let mut child = Command::new("node")
        .arg(script)
        .current_dir(worktree)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("failed to start node: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("failed to read the ESLint rules: node stdin is not available")?;
    stdin.write_all(input.as_bytes()).await.map_err(|error| format!("failed to read the ESLint rules: {error}"))?;
    drop(stdin);

    let output = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| "failed to read the ESLint rules: no answer in time".to_string())?
        .map_err(|error| format!("failed to read the ESLint rules: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("failed to read the ESLint rules: node exited with {}: {}", output.status, stderr.trim()));
    }
    parse_output(&output.stdout)
}

fn parse_output(stdout: &[u8]) -> Result<LintRules, String> {
    let output: LintRules = serde_json::from_slice(stdout).map_err(|error| format!("failed to read the ESLint rules: {error}"))?;
    match output.error {
        Some(error) => Err(format!("failed to read the ESLint rules: {error}")),
        None => Ok(output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_flat_config_files_only() {
        assert!(is_config("eslint.config.mjs"));
        assert!(is_config("apps/web/eslint.config.ts"));
        assert!(!is_config(".eslintrc.json"));
        assert!(!is_config("apps/web/my-eslint.config.js"));
    }

    #[test]
    fn reads_configs_and_errors() {
        let rules = parse_output(
            br#"{"configs":[{"path":"eslint.config.js","installed":true,"error":null,"blocks":[{"files":["**/*.ts"],"ignores":[],
                "rules":[{"id":"eqeqeq","severity":"error","options":["always"],"description":"Require `===`","url":null,"origin":"core"}]}]},
                {"path":"apps/web/eslint.config.js","installed":false,"error":null,"blocks":[]}]}"#,
        )
        .unwrap();
        assert_eq!(rules.configs.len(), 2);
        assert_eq!(rules.configs[0].blocks[0].rules[0].id, "eqeqeq");
        assert_eq!(rules.configs[0].blocks[0].rules[0].options, json!(["always"]));
        assert!(!rules.configs[1].installed);
        assert_eq!(parse_output(br#"{"error":"Unexpected token"}"#).unwrap_err(), "failed to read the ESLint rules: Unexpected token");
    }

    #[tokio::test]
    async fn reads_the_rules_of_this_repository() {
        if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).all(|dir| !dir.join("node").is_file()) {
            println!("node not installed, skipping");
            return;
        }
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        let rules = read_lint_rules(&root.join(SCRIPT), &root, &["eslint.config.js".to_string()]).await.unwrap();
        let config = &rules.configs[0];
        assert!(config.installed && config.error.is_none(), "{config:?}");
        let rules: Vec<&LintRule> = config.blocks.iter().flat_map(|block| &block.rules).collect();
        let curly = rules.iter().find(|rule| rule.id == "curly").unwrap();
        assert_eq!((curly.severity.as_str(), curly.origin.as_str()), ("error", "core"));
        assert_eq!(curly.options, json!(["multi-line"]));
        assert!(curly.description.is_some());
        let switched_off = rules.iter().find(|rule| rule.id == "@typescript-eslint/no-non-null-assertion" && rule.severity == "off").unwrap();
        assert_eq!(switched_off.origin, "package");
    }
}
