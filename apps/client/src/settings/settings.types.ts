/**
 * How Hunt reaches the gateway, from Settings → Remote VM (mirror of `VmSettings` in src-tauri/src/remote/gateway.rs): the
 * backend finds the VM of `project` labelled `hunt-role=gateway`, whose API provisions, starts and deletes the session
 * VMs. `machineType` replaces the instance template's for the session VMs it creates; null keeps the template's.
 */
export type VmSettings = { project: string; machineType: string | null };

/** Whether the GitHub token of remote sessions is stored; `hint` holds its last four characters. */
export type GithubTokenStatus = { saved: boolean; hint: string | null };

/**
 * A remote secret the gateway keeps for every session VM (mirror of `RemoteSecretSummary` in src-tauri/src/remote/api.rs);
 * `hint` holds the last four characters of a value of at least 12 characters, else it is empty. Hunt never reads values back.
 */
export type RemoteSecretSummary = { name: string; hint: string };

/**
 * The `hunt` command line tool on the PATH (mirror of `CliInstall` in src-tauri/src/platform/cli_install.rs): `linkPath` is the
 * full path of `~/.local/bin/hunt`, `installed` whether it links to this Hunt's `hunt-cli`, `onPath` whether its folder is on the PATH.
 */
export type CliInstall = { linkPath: string; installed: boolean; onPath: boolean };
