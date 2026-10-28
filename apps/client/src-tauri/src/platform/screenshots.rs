//! The macOS screenshot folder: where `⇧⌘3` / `⇧⌘4` save their files, and the images in it.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::process::Command;

/// Image types the chat can attach and the agent can read.
const IMAGE_EXTENSIONS: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub name: String,
    pub path: String,
    /// Last modification as unix milliseconds.
    pub modified_at: u64,
}

/// The folder macOS saves screenshots to: the `com.apple.screencapture location` default, or the Desktop.
pub async fn screenshot_dir() -> Result<PathBuf, String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?);
    let output = Command::new("defaults").args(["read", "com.apple.screencapture", "location"]).output().await;
    if let Ok(output) = output {
        if output.status.success() {
            let location = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(dir) = expand_home(&location, &home) {
                if dir.is_dir() {
                    return Ok(dir);
                }
            }
        }
    }
    Ok(home.join("Desktop"))
}

fn expand_home(location: &str, home: &PathBuf) -> Option<PathBuf> {
    if location.is_empty() {
        return None;
    }
    if location == "~" {
        return Some(home.clone());
    }
    if let Some(rest) = location.strip_prefix("~/") {
        return Some(home.join(rest));
    }
    Some(PathBuf::from(location))
}

/// MIME type of an image file by its extension; `None` for anything the chat cannot attach.
pub fn image_mime_type(path: &str) -> Option<&'static str> {
    let extension = path.rsplit('.').next()?.to_ascii_lowercase();
    IMAGE_EXTENSIONS.iter().find(|(candidate, _)| *candidate == extension).map(|(_, mime)| *mime)
}

/// Every image in the screenshot folder, newest first.
pub async fn list_screenshots() -> Result<Vec<Screenshot>, String> {
    let dir = screenshot_dir().await?;
    let mut screenshots = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if let Some(screenshot) = image_file(&path) {
            screenshots.push(screenshot);
        }
    }
    screenshots.sort_by(|left, right| right.modified_at.cmp(&left.modified_at).then_with(|| left.name.cmp(&right.name)));
    Ok(screenshots)
}

/// The image files among `paths` (e.g. files dropped into the chat), in the given order; folders, files of other
/// types and paths that do not exist are left out.
pub fn image_files(paths: &[String]) -> Vec<Screenshot> {
    paths.iter().filter_map(|path| image_file(Path::new(path))).collect()
}

/// `path` as an attachable image, or `None` when it is not an image file.
fn image_file(path: &Path) -> Option<Screenshot> {
    let path_text = path.to_str()?;
    image_mime_type(path_text)?;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    Some(Screenshot { name: path.file_name()?.to_string_lossy().into_owned(), path: path_text.to_string(), modified_at })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_files_keeps_only_existing_image_files() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("shot.PNG");
        std::fs::write(&image, [1u8, 2, 3]).unwrap();
        let text = dir.path().join("notes.txt");
        std::fs::write(&text, "hi").unwrap();
        let folder = dir.path().join("pictures.png");
        std::fs::create_dir(&folder).unwrap();
        let missing = dir.path().join("gone.jpg");
        let paths: Vec<String> = [&text, &folder, &missing, &image].iter().map(|path| path.to_string_lossy().into_owned()).collect();

        let files = image_files(&paths);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "shot.PNG");
        assert_eq!(files[0].path, image.to_string_lossy());
        assert!(files[0].modified_at > 0);
    }

    #[test]
    fn expands_tilde() {
        let home = PathBuf::from("/Users/me");
        assert_eq!(expand_home("~/Screenshots", &home), Some(PathBuf::from("/Users/me/Screenshots")));
        assert_eq!(expand_home("~", &home), Some(home.clone()));
        assert_eq!(expand_home("/tmp/shots", &home), Some(PathBuf::from("/tmp/shots")));
        assert_eq!(expand_home("", &home), None);
    }

    #[test]
    fn recognizes_image_types() {
        assert_eq!(image_mime_type("/a/Shot.PNG"), Some("image/png"));
        assert_eq!(image_mime_type("/a/photo.jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_type("/a/clip.mov"), None);
        assert_eq!(image_mime_type("/a/noext"), None);
    }
}
