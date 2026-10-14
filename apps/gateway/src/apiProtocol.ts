/**
 * The wire format of the gateway API (`libs/domain/src/gatewayApi.ts`) between the forwarder `apiClient.ts` and the
 * daemon `api.ts`, free of I/O: the request line `{caller, method, params}` the forwarder sends over the Unix socket,
 * the validation of its method and params, and the NDJSON events that answer it.
 */
import { messageOf } from "../../../libs/domain/src/errors.ts";
import { METHODS, type ApiEvent, type ErrorCode, type Method, type Methods } from "../../../libs/domain/src/gatewayApi.ts";
import { encodeLine, parseLine } from "../../../libs/domain/src/ndjson.ts";
import { COMPUTE_NAME, MAX_SESSIONS_LIMIT, REPOSITORY } from "./swfConfig.ts";

/** The daemon's Unix socket, in the runtime directory of `hunt-api.service`, which only hunt-gw can open. */
export const SOCKET_PATH = "/run/hunt-api/api.sock";
/** A method name as `hunt-api <method>` passes it; `apps/gateway/vm/hunt-api` checks the same pattern. */
export const METHOD_PATTERN = /^[a-z]+(\.[a-zA-Z]+)?$/;
/** A session ID: a lowercase UUID, as the desktop and the poller create them. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A Linux user name as OS Login creates them, such as `jane_doe_example_com` or `sa_1234567890`. */
const CALLER = /^[a-z_][a-z0-9_.-]{0,99}$/;
export const TITLE_MAX_LENGTH = 300;
const BRANCH_MAX_LENGTH = 250;
const MAX_REPOS = 100;
/** The longest request line the daemon reads. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** A failure the API reports with its code; any other error becomes `internal`. */
export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** A validated request; `method` narrows `params`. */
export type ApiRequest = { [M in Method]: { caller: string; method: M; params: Methods[M]["request"] } }[Method];

function invalid(message: string): ApiError {
  return new ApiError("invalidParams", message);
}

function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Whether `name` is a branch name `git check-ref-format --branch` accepts, at most BRANCH_MAX_LENGTH characters. */
export function isBranchName(name: string): boolean {
  if (!name || name.length > BRANCH_MAX_LENGTH || hasControlCharacters(name) || /[\s~^:?*[\\]/.test(name)) return false;
  if (name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  if (name.includes("..") || name.includes("//") || name.includes("@{")) return false;
  return name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseMethod(value: unknown): Method {
  if (typeof value !== "string" || !METHOD_PATTERN.test(value) || !(METHODS as readonly string[]).includes(value)) {
    throw invalid(`unknown method ${JSON.stringify(value)}; the gateway serves ${METHODS.join(", ")}`);
  }
  return value as Method;
}

function paramsObject(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("params must be a JSON object");
  return value as Record<string, unknown>;
}

function sessionId(params: Record<string, unknown>): string {
  const id = params.id;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw invalid("id must be a session ID (a lowercase UUID)");
  return id;
}

function machineType(params: Record<string, unknown>): string | null {
  const value = params.machineType ?? null;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !COMPUTE_NAME.test(value)) throw invalid("machineType must be a Compute Engine machine type or null");
  return value;
}

/** The params of `method`, validated; unknown keys are ignored. */
export function parseParams(method: Method, value: unknown): Methods[Method]["request"] {
  const params = paramsObject(value);
  switch (method) {
    case "hello":
    case "sessions.list":
    case "swf.getConfig":
      return {};
    case "vms.get":
    case "vms.start":
    case "vms.stop":
    case "vms.delete":
      return { id: sessionId(params) };
    case "sessions.provision": {
      const { title, repo, branch } = params;
      if (typeof title !== "string" || title.length > TITLE_MAX_LENGTH || hasControlCharacters(title)) {
        throw invalid(`title must be a line of at most ${TITLE_MAX_LENGTH} characters`);
      }
      if (typeof repo !== "string" || !REPOSITORY.test(repo)) throw invalid("repo must be <owner>/<repo>");
      if (typeof branch !== "string" || !isBranchName(branch)) throw invalid("branch must be a valid Git branch name");
      return { id: sessionId(params), title, repo, branch, machineType: machineType(params) };
    }
    case "swf.applyConfig": {
      const { repos, maxSessions } = params;
      if (!Array.isArray(repos) || repos.length > MAX_REPOS || !repos.every((repo) => typeof repo === "string" && REPOSITORY.test(repo.trim()))) {
        throw invalid(`repos must be a list of at most ${MAX_REPOS} <owner>/<repo>`);
      }
      if (typeof maxSessions !== "number" || !Number.isInteger(maxSessions) || maxSessions < 0 || maxSessions > MAX_SESSIONS_LIMIT) {
        throw invalid(`maxSessions must be a whole number from 0 to ${MAX_SESSIONS_LIMIT}`);
      }
      return { repos: repos as string[], maxSessions, machineType: machineType(params) };
    }
  }
}

/** The request line `{caller, method, params}`; throws an ApiError for anything else. */
export function parseRequest(line: string): ApiRequest {
  const value = parseLine(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("the request is no JSON object");
  const { caller, method, params } = value as Record<string, unknown>;
  if (typeof caller !== "string" || !CALLER.test(caller)) throw new ApiError("forbidden", "the request names no valid caller");
  const parsedMethod = parseMethod(method);
  return { caller, method: parsedMethod, params: parseParams(parsedMethod, params) } as ApiRequest;
}

export function encodeEvent(event: ApiEvent): string {
  return encodeLine(event);
}

/** The `error` event of a failure: an ApiError keeps its code, anything else is `internal`. */
export function errorEvent(error: unknown): ApiEvent {
  if (error instanceof ApiError) return { type: "error", code: error.code, message: error.message };
  return { type: "error", code: "internal", message: messageOf(error) };
}

/** The event of one NDJSON line; null for a line that is no event. */
export function parseEvent(line: string): ApiEvent | null {
  const value = parseLine(line) as { type?: unknown } | undefined;
  if (!value || typeof value !== "object") return null;
  switch (value.type) {
    case "progress":
    case "log":
    case "result":
    case "error":
      return value as ApiEvent;
    default:
      return null;
  }
}

/** Whether `event` ends the stream: `result` or `error`. */
export function isFinalEvent(event: ApiEvent): boolean {
  return event.type === "result" || event.type === "error";
}
