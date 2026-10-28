/** The state of a hunt.json service's systemd unit on the session's VM. */
export type PreviewServiceState = "running" | "starting" | "failed" | "stopped";

/**
 * A service the repository's hunt.json declares (mirror of `PreviewService` in src-tauri/src/remote/preview.rs). `url`
 * is `https://<short>-<port>.<domain>` behind the Google login, or `https://<short>-<port>-open.<domain>` without it for
 * a service with `"guarded": false`. An `enabled` service comes back after a VM boot; `responds` says whether its port
 * listens on the VM.
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
};

/**
 * The preview of a remote session (mirror of `PreviewStatus` in src-tauri/src/remote/preview.rs). Hunt builds the URLs
 * from the session ID and its preview domain; the VM reports only the services' states and the listening ports.
 * `services` holds every service of the repository's hunt.json in file order, `listening` the other ports something
 * listens on, each at `https://<short>-<port>.<domain>`. While the VM is off, both are empty.
 */
export type PreviewStatus = { vmRunning: boolean; services: PreviewService[]; listening: PreviewPort[] };

export type PreviewPort = { port: number; url: string };
