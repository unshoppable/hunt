//! User preferences the backend needs for the prompts it writes itself; the frontend owns them (localStorage)
//! and pushes them here at start and on every change.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// Language of the agent output Hunt asks for on its own: diagram labels, session summaries, titles.
pub const DEFAULT_AI_LANGUAGE: &str = "German";

pub struct Preferences {
    ai_language: Mutex<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self { ai_language: Mutex::new(DEFAULT_AI_LANGUAGE.to_string()) }
    }
}

/// Language name (in English, e.g. `German`) to put into the prompts Hunt sends without the user's input.
pub fn ai_language(app: &AppHandle) -> String {
    app.state::<Preferences>().ai_language.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_ai_language(preferences: State<'_, Preferences>, language: String) -> Result<(), String> {
    let language = language.trim();
    if language.is_empty() {
        return Err("the language is empty".into());
    }
    *preferences.ai_language.lock().unwrap() = language.to_string();
    Ok(())
}
