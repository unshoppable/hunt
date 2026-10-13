// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A .app launched from Finder does not inherit the shell PATH; node and git must still resolve.
    let _ = fix_path_env::fix();
    hunt_lib::run()
}
