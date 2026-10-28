//! `hunt`, Hunt's command line (see `hunt_lib::cli`); Settings links it as `~/.local/bin/hunt`.

fn main() -> std::process::ExitCode {
    hunt_lib::cli::main()
}
