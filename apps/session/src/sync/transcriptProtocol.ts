/**
 * The NDJSON protocol of the session VM's transcript helper (`transcripts.ts`) with the desktop client, one JSON object
 * per line on the helper's stdin and stdout. The helper streams the files of the agent's Claude Code project folder
 * (`~/.claude/projects/<slug>`: the transcripts the agent appends to, their subagent transcripts and tool results) as
 * they grow, and appends what the client sends for the files the client owns (the transcripts of the sub chats that run
 * on the desktop).
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
import { isRecord } from "../../../../libs/domain/src/jsonRpc.ts";
import { pathProblem } from "./protocol.ts";

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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Parses one line from the client, or says why it is refused. */
export function parseTranscriptRequest(line: string): { request: TranscriptRequest } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: "malformed request: not JSON" };
  }
  if (!isRecord(value)) return { error: "malformed request: expected a JSON object" };
  switch (value.t) {
    case "sync": {
      if (!isRecord(value.files)) return { error: "malformed sync: files must be an object" };
      if (!Array.isArray(value.owned)) return { error: "malformed sync: owned must be an array" };
      const files = new Map<string, number>();
      for (const [path, offset] of Object.entries(value.files)) {
        const problem = pathProblem(path);
        if (problem) return { error: `malformed sync: ${problem}` };
        if (!isOffset(offset)) return { error: `malformed sync: the offset of ${path} must be a non-negative integer` };
        files.set(path, offset);
      }
      for (const path of value.owned) {
        const problem = pathProblem(path);
        if (problem) return { error: `malformed sync: ${problem}` };
      }
      return { request: { t: "sync", files, owned: value.owned as string[] } };
    }
    case "read": {
      const problem = pathProblem(value.path);
      if (problem) return { error: `malformed read: ${problem}` };
      if (!isOffset(value.offset)) return { error: "malformed read: offset must be a non-negative integer" };
      return { request: { t: "read", path: value.path as string, offset: value.offset } };
    }
    case "write": {
      const { id, data, truncate } = value;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return { error: "malformed write: id must be an integer" };
      const problem = pathProblem(value.path);
      if (problem) return { error: `malformed write ${id}: ${problem}` };
      if (!isOffset(value.offset)) return { error: `malformed write ${id}: offset must be a non-negative integer` };
      if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return { error: `malformed write ${id}: data must be base64` };
      if (typeof truncate !== "boolean") return { error: `malformed write ${id}: truncate must be a boolean` };
      return { request: { t: "write", id, path: value.path as string, offset: value.offset, data: Buffer.from(data, "base64"), truncate } };
    }
    default:
      return { error: `malformed request: unknown type ${JSON.stringify(value.t)}` };
  }
}
