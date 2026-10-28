/**
 * The NDJSON protocol of the session VM's transcript helper (`transcript-helper.service.ts`) with the desktop client,
 * one JSON object per line on the helper's stdin and stdout; `transcript-protocol.utils.ts` parses the client's
 * requests. The helper streams the files of the agent's Claude Code project folder (`~/.claude/projects/<slug>`: the
 * transcripts the agent appends to, their subagent transcripts and tool results) as they grow, and appends what the
 * client sends for the files the client owns (the transcripts of the sub chats that run on the desktop).
 *
 * Helper → client:
 * - `{"t":"ready"}` once the folder is watched; nothing is reported before the client's `sync`.
 * - `{"t":"file","path","offset":n,"data":base64,"size":m}`: the bytes from `offset` of a file whose size is `m` now, at
 *   most `CHUNK_BYTES` at a time; `offset + data.length == size` means the file was read to its end.
 * - `{"t":"reset","path"}`: the file shrank or was replaced; the client drops its copy, and the content follows from 0.
 * - `{"t":"gone","path"}`: the file was deleted.
 * - `{"t":"ack","id","size":n}` or `{"t":"ack","id","error":"…"}`: the size of the file after the `write` with that ID,
 *   or why it was refused (the file is not as long as the write expected).
 * - `{"t":"error","message":"…"}`: a malformed request; the helper keeps running.
 *
 * Client → helper:
 * - `{"t":"sync","files":{path: offset…},"owned":[path…]}`: what the client has: per file the bytes it holds, and the
 *   paths it owns, which the helper never reports. The helper then reports every file from the offset the client holds
 *   (`reset` first when the file is shorter), `gone` for a file the client holds that is not there, and new files from 0.
 * - `{"t":"read","path","offset":n}`: report the file from `offset` again.
 * - `{"t":"write","id","path","offset":n,"data":base64,"truncate":bool}`: append `data` to a file the client owns, which
 *   must be `offset` bytes long, or with `truncate` replace its content.
 *
 * Paths are relative to the project folder with `/`; `memory/` is never reported.
 */

/** The most bytes of one `file` message. */
export const CHUNK_BYTES = 1024 * 1024;

export type TranscriptMessage =
  | { t: "ready" }
  | { t: "file"; path: string; offset: number; data: string; size: number }
  | { t: "reset"; path: string }
  | { t: "gone"; path: string }
  | { t: "ack"; id: number; size: number }
  | { t: "ack"; id: number; error: string }
  | { t: "error"; message: string };

export type TranscriptRequest =
  | { t: "sync"; files: Map<string, number>; owned: string[] }
  | { t: "read"; path: string; offset: number }
  | { t: "write"; id: number; path: string; offset: number; data: Buffer; truncate: boolean };
