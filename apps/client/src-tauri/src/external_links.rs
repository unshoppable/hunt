//! Keeps every webview on the app's own pages: a navigation to a web or mail link opens in the default browser instead.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime, Url};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("external-links")
        .on_navigation(|webview, url| {
            let dev_url = if tauri::is_dev() { webview.app_handle().config().build.dev_url.clone() } else { None };
            if !opens_externally(url, dev_url.as_ref()) {
                return true;
            }
            if let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
                eprintln!("failed to open {url} in the browser: {error}");
            }
            false
        })
        .build()
}

/// Whether `url` leaves the app: an `http`, `https` or `mailto` link outside `dev_url`'s origin, the dev server that
/// serves the app's pages during `tauri dev` (built apps serve them from `tauri://`).
fn opens_externally(url: &Url, dev_url: Option<&Url>) -> bool {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return false;
    }
    dev_url.is_none_or(|dev_url| dev_url.origin() != url.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn web_and_mail_links_open_externally() {
        assert!(opens_externally(&url("https://github.com/unshoppable/hunt"), None));
        assert!(opens_externally(&url("http://example.com"), None));
        assert!(opens_externally(&url("mailto:someone@example.com"), None));
    }

    #[test]
    fn the_app_pages_stay_in_the_webview() {
        let dev_url = url("http://localhost:1420");
        assert!(!opens_externally(&url("tauri://localhost/editor.html"), None));
        assert!(!opens_externally(&url("http://localhost:1420/settings.html"), Some(&dev_url)));
        assert!(!opens_externally(&url("about:blank"), None));
        assert!(opens_externally(&url("http://localhost:3000"), Some(&dev_url)));
    }
}
