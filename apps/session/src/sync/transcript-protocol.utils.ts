/** Parsing for the transcript protocol of `transcript-protocol.types.ts`. */
import { isRecord } from "../../../../libs/domain/src/shared/json-rpc.utils.ts";
import { pathProblem } from "./sync-protocol.utils.ts";
import type { TranscriptRequest } from "./transcript-protocol.types.ts";

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
