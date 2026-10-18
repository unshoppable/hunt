/**
 * The NDJSON protocol of the session VM's file-sync helper (`helper.ts`) with the desktop client, one JSON object per
 * line on the helper's stdin and stdout.
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
 * symbolic link; `null` means no file is there. Folders are never reported as files.
 */
import { isRecord } from "../../../../libs/domain/src/jsonRpc.ts";

/** Content up to this size travels inline as base64 in `data`. */
export const INLINE_DATA_MAX_BYTES = 1024 * 1024;

export interface FileState {
  size: number;
  /** Nanoseconds since the epoch as a decimal string. */
  modifiedNs: string;
  executable: boolean;
  link: boolean;
}

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

/** A parsed request with the problems of the entries it skipped, or why the whole line was refused. */
export type ParsedRequest = { request: ApplyRequest; problems: string[] } | { error: string };

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;

/**
 * Why `path` may not be applied, or null when it may: it must be relative, use `/` between non-empty segments other
 * than `.` and `..`, hold no NUL and lie outside `.git`.
 */
export function pathProblem(path: unknown): string | null {
  if (typeof path !== "string" || !path) return "path must be a non-empty string";
  if (path.includes("\0")) return `path ${JSON.stringify(path)} contains a NUL character`;
  if (path.startsWith("/")) return `path ${JSON.stringify(path)} is absolute`;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return `path ${JSON.stringify(path)} has an empty, "." or ".." segment`;
  }
  if (segments[0] === ".git") return `path ${JSON.stringify(path)} lies inside .git`;
  return null;
}

function parseModifiedNs(value: unknown): bigint | null {
  return typeof value === "string" && DECIMAL.test(value) ? BigInt(value) : null;
}

function parseWrite(value: unknown, index: number): FileWrite | string {
  if (!isRecord(value)) return `writes[${index}] must be an object`;
  const problem = pathProblem(value.path);
  if (problem) return `writes[${index}]: ${problem}`;
  const { path, data, executable } = value as { path: string; data: unknown; executable: unknown };
  if (typeof data !== "string" || data.length % 4 !== 0 || !BASE64.test(data)) return `writes[${index}] (${path}): data must be base64`;
  if (typeof executable !== "boolean") return `writes[${index}] (${path}): executable must be a boolean`;
  const modifiedNs = parseModifiedNs(value.modifiedNs);
  if (modifiedNs === null) return `writes[${index}] (${path}): modifiedNs must be a decimal string`;
  return { path, data: Buffer.from(data, "base64"), executable, modifiedNs };
}

function parseLink(value: unknown, index: number): LinkWrite | string {
  if (!isRecord(value)) return `links[${index}] must be an object`;
  const problem = pathProblem(value.path);
  if (problem) return `links[${index}]: ${problem}`;
  const { path, target } = value as { path: string; target: unknown };
  if (typeof target !== "string" || !target || target.includes("\0")) return `links[${index}] (${path}): target must be a non-empty string without NUL`;
  const modifiedNs = parseModifiedNs(value.modifiedNs);
  if (modifiedNs === null) return `links[${index}] (${path}): modifiedNs must be a decimal string`;
  return { path, target, modifiedNs };
}

function parseDelete(value: unknown, index: number): { path: string } | string {
  const problem = pathProblem(value);
  return problem ? `deletes[${index}]: ${problem}` : { path: value as string };
}

/** Parses the entries of `list`, collecting the valid ones and the problems of the others. */
function parseEntries<T>(list: unknown[], parse: (value: unknown, index: number) => T | string, problems: string[]): T[] {
  const entries: T[] = [];
  list.forEach((value, index) => {
    const parsed = parse(value, index);
    if (typeof parsed === "string") {
      problems.push(parsed);
      return;
    }
    entries.push(parsed);
  });
  return entries;
}

/** Parses one line from the client. Missing lists count as empty; an invalid entry is skipped and named in `problems`. */
export function parseRequest(line: string): ParsedRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { error: "malformed request: not JSON" };
  }
  if (!isRecord(value)) return { error: "malformed request: expected a JSON object" };
  if (value.t !== "apply") return { error: `malformed request: unknown type ${JSON.stringify(value.t)}` };
  const { id } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return { error: "malformed request: id must be an integer" };
  const lists: Record<"writes" | "links" | "deletes", unknown[]> = { writes: [], links: [], deletes: [] };
  for (const key of ["writes", "links", "deletes"] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { error: `malformed request ${id}: ${key} must be an array` };
    lists[key] = list;
  }
  const problems: string[] = [];
  const writes = parseEntries(lists.writes, parseWrite, problems);
  const links = parseEntries(lists.links, parseLink, problems);
  const deletes = parseEntries(lists.deletes, parseDelete, problems).map((entry) => entry.path);
  return { request: { id, writes, links, deletes }, problems: problems.map((problem) => `request ${id}: skipped ${problem}`) };
}

/** Whether two states describe the same file. */
export function sameState(a: FileState | null, b: FileState | null): boolean {
  if (!a || !b) return a === b;
  return a.size === b.size && a.modifiedNs === b.modifiedNs && a.executable === b.executable && a.link === b.link;
}

/** Splits `reports` into `changes` messages of at most `maxDataBytes` of inline data each, never splitting a report. */
export function changeMessages(reports: FileReport[], maxDataBytes: number): HelperMessage[] {
  const messages: HelperMessage[] = [];
  let files: FileReport[] = [];
  let bytes = 0;
  for (const report of reports) {
    const size = report.data?.length ?? 0;
    if (files.length && bytes + size > maxDataBytes) {
      messages.push({ t: "changes", files });
      files = [];
      bytes = 0;
    }
    files.push(report);
    bytes += size;
  }
  if (files.length) {
    messages.push({ t: "changes", files });
  }
  return messages;
}
