//! A debug build restarts with every Rust change under `tauri dev` and must not take the focus from the app the change was
//! made in. Besides the activation at launch (see `activate_ignoring_other_apps` in `lib.rs`), wry calls
//! `-[NSApplication activate]` whenever it creates a webview (`wkwebview/mod.rs`, unconditionally): for the main window and
//! for every editor window booted hidden ahead of time (`ide/editor-window.utils.ts`). Hunt itself brings a window to the
//! front through `set_focus`, i.e. `activateIgnoringOtherApps:`, which stays as it is.

use objc2::runtime::{AnyObject, Imp, Sel};
use objc2::{class, sel};

unsafe extern "C-unwind" fn ignore_activate(_app: &AnyObject, _cmd: Sel) {}

/// Turns `-[NSApplication activate]` into a no-op for the rest of the process; call it before the app runs.
pub fn ignore() {
    let Some(method) = class!(NSApplication).instance_method(sel!(activate)) else { return };
    // SAFETY: the replacement has the method's signature (`-(void)activate`), and the app has not started yet, so nothing
    // calls the method meanwhile.
    unsafe {
        method.set_implementation(std::mem::transmute::<unsafe extern "C-unwind" fn(&AnyObject, Sel), Imp>(ignore_activate));
    }
}
