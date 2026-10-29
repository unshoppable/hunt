//! User preferences the backend needs for the prompts it writes itself; the frontend owns them (localStorage)
//! and pushes them here at start and on every change.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

/// Language of the agent output Hunt asks for on its own: diagram labels, session summaries, titles.
pub const DEFAULT_AI_LANGUAGE: &str = "German";

/// Follows every instruction that sets the AI language: developers mix English technical terms into their own
/// language, and translated stand-ins (German "Hilfen" for utils) read worse than the terms themselves.
pub const ENGLISH_TERMS: &str = "Keep the English technical terms and abbreviations developers use in that language \
untranslated, e.g. utils, helper, service, store, hook, endpoint, payload, parser; never invent a translation for them.";

/// Response-style instructions appended to the agent's system prompt in every session; the frontend imports the
/// same file (`prompts/session/response-style.system-prompt.md`) as its default, so the settings dialog can tell a default from an edit.
pub const DEFAULT_SYSTEM_PROMPT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../prompts/session/response-style.system-prompt.md"));

pub struct Preferences {
    ai_language: Mutex<String>,
    system_prompt: Mutex<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            ai_language: Mutex::new(DEFAULT_AI_LANGUAGE.to_string()),
            system_prompt: Mutex::new(DEFAULT_SYSTEM_PROMPT.trim().to_string()),
        }
    }
}

/// Language name (in English, e.g. `German`) to put into the prompts Hunt sends without the user's input.
pub fn ai_language(app: &AppHandle) -> String {
    app.state::<Preferences>().ai_language.lock().unwrap().clone()
}

/// The user's system prompt addition for every agent session; empty when the user cleared it.
pub fn system_prompt(app: &AppHandle) -> String {
    app.state::<Preferences>().system_prompt.lock().unwrap().clone()
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

/// An empty prompt is allowed: it switches the addition off for sessions started afterwards.
#[tauri::command]
pub fn set_system_prompt(preferences: State<'_, Preferences>, prompt: String) {
    *preferences.system_prompt.lock().unwrap() = prompt.trim().to_string();
}
