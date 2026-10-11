//! Turns the review comments drafted in a session into what GitHub takes: a comment on lines inside a hunk of the
//! pull request's diff is posted inline, every other one becomes a note in the review summary, with the commented
//! lines as a code block so the reader sees what it is about.

use std::collections::HashMap;
use std::ops::RangeInclusive;
use std::path::Path;

use crate::git;
use crate::github::{InlineComment, ReviewComment};
use crate::session::store::SessionRecord;

/// The summary and the inline comments the review of `record`'s pull request is submitted with: `body` followed
/// by a note per draft outside the diff hunks, and the drafts inside them as inline comments, in the drafts' order.
pub async fn prepare(record: &SessionRecord, drafts: &[ReviewComment], body: &str) -> Result<(String, Vec<InlineComment>), String> {
    let mut hunks_by_path: HashMap<&str, Vec<RangeInclusive<u32>>> = HashMap::new();
    let mut inline = Vec::new();
    let mut notes = Vec::new();
    for draft in drafts {
        git::ensure_inside_worktree(&draft.path)?;
        if !hunks_by_path.contains_key(draft.path.as_str()) {
            let diff = git::file_diff(&record.worktree_path, record.diff_base(), &draft.path).await?;
            hunks_by_path.insert(&draft.path, git::unified_new_line_ranges(&diff.unified));
        }
        let hunks = &hunks_by_path[draft.path.as_str()];
        if hunks.iter().any(|hunk| hunk.contains(&draft.start_line) && hunk.contains(&draft.line)) {
            inline.push(InlineComment { path: draft.path.clone(), start_line: draft.start_line, line: draft.line, body: draft.body.clone() });
        } else {
            let code = read_lines(&record.worktree_path.join(&draft.path), draft.start_line, draft.line)?;
            notes.push(format_note(&draft.path, draft.start_line, draft.line, &code, &draft.body));
        }
    }
    Ok((with_notes(body, &notes), inline))
}

/// Lines `start_line..=line` (1-based) of the file at `path`, joined with newlines.
fn read_lines(path: &Path, start_line: u32, line: u32) -> Result<String, String> {
    let content = std::fs::read_to_string(path).map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let skipped = start_line.saturating_sub(1) as usize;
    let count = (line.saturating_sub(start_line) + 1) as usize;
    Ok(content.lines().skip(skipped).take(count).collect::<Vec<_>>().join("\n"))
}

/// A note of the review summary: the location, the commented lines fenced with the file extension as language,
/// then the comment. The fence outgrows any run of backticks in the code.
fn format_note(path: &str, start_line: u32, line: u32, code: &str, body: &str) -> String {
    let location = if start_line == line { format!("`{path}:{line}`") } else { format!("`{path}:{start_line}-{line}`") };
    let longest_backtick_run = code.split(|character| character != '`').map(str::len).max().unwrap_or(0);
    let fence = "`".repeat(longest_backtick_run.max(2) + 1);
    let language = Path::new(path).extension().and_then(|extension| extension.to_str()).unwrap_or("");
    format!("{location}\n{fence}{language}\n{code}\n{fence}\n{body}")
}

/// The summary with the notes appended under a rule; without a summary the notes stand alone.
fn with_notes(body: &str, notes: &[String]) -> String {
    let body = body.trim();
    if notes.is_empty() {
        return body.to_string();
    }
    let notes = notes.join("\n\n");
    if body.is_empty() {
        return notes;
    }
    format!("{body}\n\n---\n\n{notes}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    async fn git(repo: &Path, args: &[&str]) -> String {
        git::run_git(repo, args).await.unwrap()
    }

    /// A review session of a worktree with two commits: `changed.txt` (40 numbered lines) and `other.txt` at the
    /// base, then lines 11 and 12 of `changed.txt` rewritten; the session diffs against the base commit.
    async fn fixture() -> (tempfile::TempDir, SessionRecord) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        git(repo, &["init", "-q", "-b", "main"]).await;
        git(repo, &["config", "user.email", "test@example.com"]).await;
        git(repo, &["config", "user.name", "Test"]).await;
        let lines: Vec<String> = (1..=40).map(|number| format!("line {number}")).collect();
        std::fs::write(repo.join("changed.txt"), format!("{}\n", lines.join("\n"))).unwrap();
        std::fs::write(repo.join("other.txt"), "a\nb\nc\n").unwrap();
        git(repo, &["add", "."]).await;
        git(repo, &["commit", "-q", "-m", "base"]).await;
        let base_commit = git(repo, &["rev-parse", "HEAD"]).await.trim().to_string();
        let mut changed = lines.clone();
        changed[10] = "line 11 changed".into();
        changed[11] = "line 12 changed".into();
        std::fs::write(repo.join("changed.txt"), format!("{}\n", changed.join("\n"))).unwrap();
        git(repo, &["commit", "-q", "-a", "-m", "pr"]).await;
        let mut record = SessionRecord::new(
            Uuid::new_v4(),
            "review".into(),
            repo.to_path_buf(),
            repo.to_path_buf(),
            "pr".into(),
            "main".into(),
            base_commit.clone(),
        );
        record.diff_base = Some(base_commit);
        (dir, record)
    }

    fn draft(path: &str, start_line: u32, line: u32, body: &str) -> ReviewComment {
        ReviewComment { id: Uuid::new_v4(), path: path.into(), start_line, line, body: body.into(), created_at: chrono::Utc::now() }
    }

    #[tokio::test]
    async fn prepare_posts_hunk_lines_inline_and_turns_the_rest_into_notes_with_their_code() {
        let (_dir, record) = fixture().await;
        let drafts = vec![
            draft("changed.txt", 11, 12, "Inside the hunk."),
            draft("changed.txt", 15, 15, "Last context line."),
            draft("changed.txt", 30, 31, "Far from the change."),
            draft("other.txt", 2, 2, "Untouched file."),
        ];

        let (body, inline) = prepare(&record, &drafts, "Summary").await.unwrap();

        let inline: Vec<(String, u32, u32, String)> = inline
            .into_iter()
            .map(|comment| (comment.path, comment.start_line, comment.line, comment.body))
            .collect();
        assert_eq!(
            inline,
            vec![("changed.txt".into(), 11, 12, "Inside the hunk.".into()), ("changed.txt".into(), 15, 15, "Last context line.".into())]
        );
        assert_eq!(
            body,
            "Summary\n\n---\n\n\
             `changed.txt:30-31`\n```txt\nline 30\nline 31\n```\nFar from the change.\n\n\
             `other.txt:2`\n```txt\nb\n```\nUntouched file."
        );
    }

    #[tokio::test]
    async fn prepare_rejects_a_draft_whose_path_leaves_the_worktree() {
        let (_dir, record) = fixture().await;
        let error = prepare(&record, &[draft("../outside.txt", 1, 1, "Nope.")], "").await.unwrap_err();
        assert!(error.contains("outside"), "{error}");
    }

    #[test]
    fn format_note_fences_the_code_with_the_file_extension_and_names_the_lines() {
        let note = format_note("src/a.ts", 4, 4, "const a = 1;", "Unused.");
        assert_eq!(note, "`src/a.ts:4`\n```ts\nconst a = 1;\n```\nUnused.");
        let note = format_note("README", 2, 3, "one\ntwo", "Merge these.");
        assert_eq!(note, "`README:2-3`\n```\none\ntwo\n```\nMerge these.");
    }

    #[test]
    fn format_note_outgrows_backticks_in_the_code() {
        let note = format_note("doc.md", 1, 1, "```js", "Nested fence.");
        assert_eq!(note, "`doc.md:1`\n````md\n```js\n````\nNested fence.");
    }

    #[test]
    fn with_notes_appends_the_notes_under_a_rule_or_lets_them_stand_alone() {
        let notes = vec!["note one".to_string(), "note two".to_string()];
        assert_eq!(with_notes("Summary ", &notes), "Summary\n\n---\n\nnote one\n\nnote two");
        assert_eq!(with_notes("  ", &notes), "note one\n\nnote two");
        assert_eq!(with_notes("Summary", &[]), "Summary");
    }
}
