//! macOS integration: the keychain, external links, the application menu, the screenshot folder, the migration from the
//! former bundle identifier, the preferences the frontend pushes, the POSIX shell (`shell.rs`), the control socket
//! through which Hunt's local agents steer the app (`control.rs`) and the `hunt` command line tool's link on the PATH
//! (`cli_install.rs`).

pub mod cli_install;
pub mod control;
pub mod external_links;
pub mod keychain;
pub mod legacy_identifier;
pub mod menu;
pub mod preferences;
pub mod screenshots;
pub mod shell;
