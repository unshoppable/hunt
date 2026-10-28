/** A Compute Engine VM: a session's own VM or the gateway. */
export type VmRef = { project: string; zone: string; instance: string };

/**
 * Who started a remote session on its VM: `handoff` is this Mac, whose local worktree waits for the session; `desktop`
 * is another person's Hunt and `swf` the gateway's poller for a GitHub issue, whose VMs this Mac adopted.
 */
export type RemoteOrigin = "handoff" | "desktop" | "swf";

/**
 * A session VM as the gateway lists it (mirror of `AdoptableSession` in src-tauri/src/remote/adoption.rs): started by
 * the gateway's poller for a GitHub issue (`swf`) or handed off by someone's Hunt (`desktop`), running or not.
 */
export type SessionVm = {
  id: string;
  vm: VmRef;
  /** The session's title, or one made from the issue or the repository when the VM names none. */
  title: string;
  /** `<owner>/<repo>` of the session's repository. */
  repo: string;
  /** The branch the session started on; empty when the VM names none. */
  branch: string;
  origin: "desktop" | "swf";
  /** The OS Login user who handed a `desktop` session off; empty for a `swf` session. */
  owner: string;
  /** The GitHub issue of a `swf` session. */
  issue: number | null;
  /** The Compute Engine status of the VM, e.g. `RUNNING` or `TERMINATED`. */
  status: string;
  isRunning: boolean;
  /** When the VM was created, ISO 8601; null when the gateway reports no time. */
  createdAt: string | null;
  /**
   * The state of the session's agent as the gateway recorded it: the step of the poller's pipeline (`plan`,
   * `implement`, `verify`, `gate`, `pr`, `review`, `human-review`, `merge`), `question` (waits for an answer), `done` or
   * `failed`; empty when unknown.
   */
  agent: string;
};

/**
 * What the relay of a remote session last reported through the status channel (mirror of `RelayActivity` in
 * src-tauri/src/remote/target.rs): whether its agent runs a turn and whether it waits for the user's answer to a question;
 * `isQuestion` is null for an older relay that does not say.
 */
export type RelayActivity = { isTurnRunning: boolean; isQuestion: boolean | null };

/** Where a session handed off to a VM runs (mirror of `RemoteTarget` in src-tauri/src/remote/target.rs). */
export type RemoteTarget = {
  /** The session's own VM, `vm-hunt-s-<short>`. */
  vm: VmRef;
  /**
   * The session's worktree on the VM; tool calls of its agent name files below this path. Empty for an adopted session
   * until Hunt first reached its VM.
   */
  worktreePath: string;
  /** `<owner>/<repo>` of the repository on the VM. */
  repo: string;
  branch: string;
  /** The commit the local branch had at the handoff; empty for an adopted session. */
  handoffHead: string;
  /** When the session went to its VM; for an adopted session when this Mac adopted it. */
  handedOffAt: string;
  /** The permission mode the session had locally, which the retrieval restores; null for older handoffs and adopted sessions, which come back in `auto`. */
  localMode: string | null;
  /** When the agent last worked on the session (a prompt Hunt sent or a turn that ended); null until the first one. */
  lastActiveAt: string | null;
  /** When Hunt last asked whether to retrieve or delete the idle session and the user chose to wait. */
  cleanupAskedAt: string | null;
  /** The preview domain the session was handed off with, which its URLs use; null for older handoffs. */
  previewDomain: string | null;
  origin: RemoteOrigin;
  /** The GitHub issue a `swf` session works on. */
  issue: number | null;
  /**
   * The state of the session's agent as the gateway recorded it: the step of the poller's pipeline (`plan`,
   * `implement`, `verify`, `gate`, `pr`, `review`, `human-review`, `merge`), `question` (waits for an answer), `done` or
   * `failed`; empty when unknown.
   */
  agent: string;
  /** The push target is not yet recorded on the VM, which Hunt could not reach when it changed; the next connect records it. */
  pushTargetPending: boolean;
  /** What the session's relay last reported through the status channel while its VM ran; null before the first report. */
  relayActivity: RelayActivity | null;
};

/** A step of a handoff, a retrieval or a connect to a remote session that takes long enough to show. */
export type RemoteStep =
  | "startingVm"
  | "resumingVm"
  | "movingVm"
  | "creatingVm"
  | "waitingForVm"
  | "connecting"
  | "installingRuntime"
  | "transferringCode"
  | "installingDependencies"
  | "startingAgent"
  | "connectingAgent"
  | "stoppingAgent"
  | "retrievingCode";

/**
 * The step a remote operation on a session is at; `null` once it ended. `detail` is the gateway's last log line about
 * the step, e.g. why the VM does not answer yet; `null` until it sends one.
 */
export type RemoteProgressEvent = { huntSessionId: string; step: RemoteStep | null; detail: string | null };

/**
 * A sync of a remote session's files with its VM started (`isRunning`) or ended (mirror of `SyncEvent` in
 * src-tauri/src/session/sync.rs): `syncedAt` when it succeeded, `error` when it failed, `conflicts` with one line per
 * file it could not sync, and `changedLocal` when it changed files of the local worktree.
 */
export type RemoteSyncEvent = {
  huntSessionId: string;
  isRunning: boolean;
  syncedAt: string | null;
  error: string | null;
  conflicts: string[];
  changedLocal: boolean;
};

/**
 * Whether the local worktree of a remote session may change (mirror of `Link` in src-tauri/src/session/link.rs): `live`
 * while it syncs with its VM, `vmStopped` while its VM is off, else `locked`: its VM runs without a sync (`vmRunning`)
 * or neither it nor the gateway can be reached (`unreachable`), so the agent there may write and Hunt refuses its own
 * writes to the worktree.
 */
export type RemoteLink = { state: "live" } | { state: "vmStopped" } | { state: "locked"; reason: "vmRunning" | "unreachable" };

/** The link of a top-level remote session changed (mirror of `LinkEvent` in src-tauri/src/session/link.rs). */
export type RemoteLinkEvent = { huntSessionId: string; link: RemoteLink };

/** What the relay of a top-level remote session reports changed (mirror of `RelayActivityEvent` in src-tauri/src/session/relay_watch.rs). */
export type RelayActivityEvent = { huntSessionId: string; relayActivity: RelayActivity };
