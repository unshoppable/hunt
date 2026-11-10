/** The state of a hunt.json service's systemd unit on the session's VM. */
export type PreviewServiceState = "running" | "starting" | "failed" | "stopped";

/**
 * A service the repository's hunt.json declares (mirror of `PreviewService` in src-tauri/src/remote/preview.rs). `url`
 * is `https://<short>-<port>.<domain>` behind the Google login, or `https://<short>-<port>-open.<domain>` without it for
 * a service with `"guarded": false`. An `enabled` service comes back after a VM boot; `responds` says whether its port
 * listens on the VM; `invocation` is systemd's ID of the unit's current run, new with every start, null while it does
 * not run.
 */
export type PreviewService = {
  name: string;
  port: number;
  url: string;
  guarded: boolean;
  tls: boolean;
  enabled: boolean;
  state: PreviewServiceState;
  responds: boolean;
  invocation: string | null;
  /**
   * The other services whose public URL its environment holds (`${services.<name>.publicUrl}` in hunt.json); the services
   * linked this way make up one app. Empty while the VM's records predate them.
   */
  uses: string[];
};

/**
 * The preview of a remote session (mirror of `PreviewStatus` in src-tauri/src/remote/preview.rs). Hunt builds the URLs
 * from the session ID and its preview domain; the VM reports only the services' states. `services` holds every service
 * of the repository's hunt.json in file order; while the VM is off, it is empty.
 */
export type PreviewStatus = { vmRunning: boolean; services: PreviewService[] };

/**
 * A hunt.json service of a local session marked `"frontend": true` whose port accepts connections on this Mac (mirror of
 * `AppPage` in src-tauri/src/agent/app_pages.rs); "Browser" opens a tab of the session's Chrome at `url`,
 * `http://localhost:<port>` (`https://` with `tls`).
 */
export type AppPage = { name: string; url: string };
