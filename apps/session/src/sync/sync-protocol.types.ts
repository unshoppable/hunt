/**
 * The NDJSON protocol of the session VM's file-sync helper (`sync-helper.service.ts`) with the desktop client, one JSON
 * object per line on the helper's stdin and stdout; `sync-protocol.utils.ts` parses the client's requests.
 *
 * Helper → client:
 * - `{"t":"ready"}` once every watch is set.
 * - `{"t":"changes","files":[FileReport…]}`: files that changed on the VM, batched over 20 ms.
 * - `{"t":"ack","id":n,"files":[{"path","state"}…]}`: the state of every path of the `apply` with that ID afterwards.
 * - `{"t":"head"}`: the VM's HEAD may have moved, at most once per batch.
 * - `{"t":"resync","reason":"…"}`: the client must run a full listing-based sync (ignore rules changed, a watch failed,
 *   or the helper could not keep up).
 * - `{"t":"error","message":"…"}`: a malformed request or an entry of one that was skipped; the helper keeps running.
 *
 * Client → helper: `{"t":"apply","id":n,"writes":[{"path","data","executable","modifiedNs"}…],
 * "links":[{"path","target","modifiedNs"}…],"deletes":[path…]}`.
 *
 * Paths are worktree-relative with `/`. A state is the file's `lstat`: its size (a link's: the target's length), its
 * modification time in nanoseconds since the epoch as a decimal string, the owner's execute bit and whether it is a
 * symbolic link (`file-state.value-object.ts`); `null` means no file is there. Folders are never reported as files.
 */
import type { FileState } from "./file-state.value-object.ts";

/** Content up to this size travels inline as base64 in `data`. */
export const INLINE_DATA_MAX_BYTES = 1024 * 1024;

export interface FileReport {
  path: string;
  state: FileState | null;
  /** False for a file Git ignores on the VM, which the client never touches; a gone path keeps what it was. */
  listed: boolean;
  /** Base64 content of a listed regular file of at most INLINE_DATA_MAX_BYTES. */
  data?: string;
  /** The target of a listed symbolic link. */
  target?: string;
}

export interface AckEntry {
  path: string;
  state: FileState | null;
}

export type HelperMessage =
  | { t: "ready" }
  | { t: "changes"; files: FileReport[] }
  | { t: "ack"; id: number; files: AckEntry[] }
  | { t: "head" }
  | { t: "resync"; reason: string }
  | { t: "error"; message: string };

export interface FileWrite {
  path: string;
  data: Buffer;
  executable: boolean;
  modifiedNs: bigint;
}

export interface LinkWrite {
  path: string;
  target: string;
  modifiedNs: bigint;
}

export interface ApplyRequest {
  id: number;
  writes: FileWrite[];
  links: LinkWrite[];
  deletes: string[];
}
